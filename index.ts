/**
 * Build script for PPA
 *
 * @packageDocumentation
 */

import * as os from "os";
import * as fs from "fs";
import * as fse from "fs-extra";
import * as https from "https";
import * as path from "path";
import { spawnSync } from "child_process";
import * as tmp from "tmp-promise";

// Drop external rimraf package once min node version is 12.10
// https://stackoverflow.com/a/57866165
import * as rimraf from "rimraf";

const email = "ppa@troyready.com";
const localSuffix = "+ztroyppa";
const rootPath = __dirname;
const ppaPath = path.join(rootPath, "debian");
const ppaDebPath = path.join(ppaPath, "pool", "main");

interface BuildContext {
  distro: string;
  installedBuildDeps: string[];
  installedPackages: string[];
  packageSourcesUpdated: boolean;
  rootUser: boolean;
}
interface BuildResponse {
  path: string;
  publishRequired: boolean;
}
interface BuildStatus {
  debDirPaths: string[];
  publishRequired: boolean;
}

/** Creates/updates PPA */
export async function updatePPA(): Promise<void> {
  let buildContext: BuildContext = {
    distro: await getDistroCodename(),
    installedBuildDeps: [],
    installedPackages: [],
    packageSourcesUpdated: false,
    rootUser: false,
  };
  try {
    buildContext.rootUser = os.userInfo().uid == 0;
  } catch {
    // docker
    // https://github.com/nodejs/node/issues/25714
    buildContext.rootUser = true;
  }

  if (process.env.GH_ACTIONS_INSTALLED_PKGS) {
    for (const pkgName of process.env.GH_ACTIONS_INSTALLED_PKGS.split(" ")) {
      buildContext.installedPackages.push(pkgName);
    }
  }
  if (process.env.GH_ACTIONS_INSTALLED_BUILD_DEPS) {
    for (const depName of process.env.GH_ACTIONS_INSTALLED_BUILD_DEPS.split(
      " ",
    )) {
      buildContext.installedBuildDeps.push(depName);
    }
  }

  const buildStatus: BuildStatus = {
    publishRequired: false,
    debDirPaths: [],
  };
  let exitCode: null | number;

  for (const builder of [runOne, evolution, libbluray, podman]) {
    const builderRes = await builder(buildContext);
    buildStatus.debDirPaths.push(builderRes.path);
    if (builderRes.publishRequired) {
      buildStatus.publishRequired = true;
    }
  }

  if (buildStatus.publishRequired) {
    await installAptPackages(["aptly"], buildContext);
    const debTmpDir = await tmp.dir({ unsafeCleanup: true });
    for (const debDirPath of buildStatus.debDirPaths) {
      for (const fileName of await fs.promises.readdir(debDirPath)) {
        if (fileName.endsWith(".deb")) {
          await fs.promises.copyFile(
            path.join(debDirPath, fileName),
            path.join(debTmpDir.path, fileName),
          );
        }
      }
    }

    if (await pathExists(ppaPath)) {
      rimraf.sync(ppaPath);
    }
    exitCode = spawnSync("aptly", ["repo", "show", "ppa"], {
      stdio: "inherit",
    }).status;
    if (exitCode == 0) {
      exitCode = spawnSync("aptly", ["publish", "show", buildContext.distro], {
        stdio: "inherit",
      }).status;
      if (exitCode == 0) {
        exitCode = spawnSync(
          "aptly",
          ["publish", "drop", buildContext.distro],
          { stdio: "inherit" },
        ).status;
        if (exitCode != 0) {
          process.exit(exitCode ? exitCode : 1);
        }
      }
      exitCode = spawnSync("aptly", ["repo", "drop", "ppa"], {
        stdio: "inherit",
      }).status;
      if (exitCode != 0) {
        process.exit(exitCode ? exitCode : 1);
      }
    }
    for (const subCommand of [
      [
        "repo",
        "create",
        "-component=main",
        "-distribution=" + buildContext.distro,
        "ppa",
      ],
      ["repo", "add", "ppa", debTmpDir.path],
      ["publish", "repo", "-architectures=amd64", "-skip-signing", "ppa"],
    ]) {
      exitCode = spawnSync("aptly", subCommand, { stdio: "inherit" }).status;
      if (exitCode != 0) {
        process.exit(exitCode ? exitCode : 1);
      }
    }
    await fse.copy(path.join(os.homedir(), ".aptly", "public"), ppaPath);

    if (process.env.CI) {
      console.log("Running in CI - pushing updated PPA to remote...");
      exitCode = spawnSync("git", ["add", ppaPath], {
        stdio: "inherit",
      }).status;
      if (exitCode != 0) {
        process.exit(exitCode ? exitCode : 1);
      }
      if (process.env.GITHUB_WORKSPACE) {
        spawnSync("git", ["config", "user.email", email], {
          stdio: "inherit",
        });
        spawnSync("git", ["config", "user.name", "CI User"], {
          stdio: "inherit",
        });
      }
      exitCode = spawnSync("git", ["commit", "-m", "CI update"], {
        stdio: "inherit",
      }).status;
      if (exitCode != 0) {
        process.exit(exitCode ? exitCode : 1);
      }
      exitCode = spawnSync("git", ["push"], {
        stdio: "inherit",
      }).status;
      if (exitCode != 0) {
        process.exit(exitCode ? exitCode : 1);
      }
    }
  }
}

export async function evolution(
  buildContext: BuildContext,
): Promise<BuildResponse> {
  let exitCode: number | null;
  const response: BuildResponse = {
    path: path.join(ppaDebPath, "e", "evolution"),
    publishRequired: false,
  };
  if (
    !process.env.GH_ACTIONS_INSTALLED_PKGS &&
    !process.env.GH_ACTIONS_INSTALLED_BUILD_DEPS
  ) {
    updatePackageSources(buildContext);
  }
  const candidates = await getPackageCandidates("evolution");
  try {
    const publishedFiles = await fs.promises.readdir(response.path);
    if (
      publishedFiles.some((fileName) => {
        return candidates.some((version) => {
          return fileName.startsWith(`evolution_${version}${localSuffix}`);
        });
      })
    ) {
      return response;
    } else {
      response.publishRequired = true;
    }
  } catch (error) {
    response.publishRequired = true;
  }

  if (response.publishRequired) {
    console.log("evolution is not published; building it...");
    await installAptPackages(["devscripts"], buildContext);
    await installAptBuildDeps(["evolution"], buildContext);

    const buildDir = await tmp.dir({ unsafeCleanup: true });
    const srcDir = path.join(buildDir.path, "evolution-3.38.3");

    exitCode = spawnSync("apt-get", ["-y", "source", "evolution"], {
      cwd: buildDir.path,
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }

    const patch = await httpsRequest({
      hostname: "gist.githubusercontent.com",
      port: 443,
      path: "/troyready/429cd82d2cf50265d21087397990ba8d/raw/27d3f23eb40a048c814585caafb3f46394826873/evolution-3.38.3-num993-6f9e3ed5.patch",
      method: "GET",
    });

    exitCode = spawnSync("git", ["apply"], {
      cwd: srcDir,
      input: patch,
    }).status;
    if (exitCode != 0) {
      console.error("Error applying git patch");
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync(
      "dch",
      ["-l" + localSuffix, "Allow editing of events"],
      {
        cwd: srcDir,
        env: { DEBEMAIL: email },
        stdio: "inherit",
      },
    ).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync("debuild", ["-b", "-uc", "-us"], {
      cwd: srcDir,
      env: { DEB_BUILD_OPTIONS: "nocheck" },
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    response.path = buildDir.path;
  }

  return response;
}

export async function podman(
  buildContext: BuildContext,
): Promise<BuildResponse> {
  let exitCode: number | null;
  const response: BuildResponse = {
    path: path.join(ppaDebPath, "libp", "libpod"),
    publishRequired: false,
  };
  if (
    !process.env.GH_ACTIONS_INSTALLED_PKGS &&
    !process.env.GH_ACTIONS_INSTALLED_BUILD_DEPS
  ) {
    updatePackageSources(buildContext);
  }
  const candidates = await getPackageCandidates("podman");
  try {
    const publishedFiles = await fs.promises.readdir(response.path);
    if (
      publishedFiles.some((fileName) => {
        return candidates.some((version) => {
          return fileName.startsWith(`podman_${version}${localSuffix}`);
        });
      })
    ) {
      return response;
    } else {
      response.publishRequired = true;
    }
  } catch (error) {
    response.publishRequired = true;
  }

  if (response.publishRequired) {
    console.log("podman is not published; building it...");
    await installAptPackages(["devscripts"], buildContext);
    await installAptBuildDeps(["podman"], buildContext);

    const buildDir = await tmp.dir({ unsafeCleanup: true });
    const srcDir = path.join(buildDir.path, "libpod-3.0.1+dfsg1");

    exitCode = spawnSync("apt-get", ["-y", "source", "podman"], {
      cwd: buildDir.path,
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }

    const patch = await httpsRequest({
      hostname: "gist.githubusercontent.com",
      port: 443,
      path: "/troyready/9779eb8b4be32325fd5566e4994202f9/raw/84f75e4dad43ef0e737518d1849bf5360f6de0bf/podman.patch",
      method: "GET",
    });

    exitCode = spawnSync("git", ["apply"], {
      cwd: srcDir,
      input: patch,
    }).status;
    if (exitCode != 0) {
      console.error("Error applying git patch");
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync("dch", ["-l" + localSuffix, "Docker api fixes"], {
      cwd: srcDir,
      env: { DEBEMAIL: email },
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync("debuild", ["-b", "-uc", "-us"], {
      cwd: srcDir,
      env: { DEB_BUILD_OPTIONS: "nocheck" },
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    response.path = buildDir.path;
  }

  return response;
}

export async function libbluray(
  buildContext: BuildContext,
): Promise<BuildResponse> {
  let exitCode: number | null;
  const response: BuildResponse = {
    path: path.join(ppaDebPath, "libb", "libbluray"),
    publishRequired: false,
  };
  if (
    !process.env.GH_ACTIONS_INSTALLED_PKGS &&
    !process.env.GH_ACTIONS_INSTALLED_BUILD_DEPS
  ) {
    updatePackageSources(buildContext);
  }
  const candidates = await getPackageCandidates("libbluray-bdj");
  try {
    const publishedFiles = await fs.promises.readdir(response.path);
    if (
      publishedFiles.some((fileName) => {
        return candidates.some((version) => {
          return fileName.startsWith(`libbluray-bdj_${version}${localSuffix}`);
        });
      })
    ) {
      return response;
    } else {
      response.publishRequired = true;
    }
  } catch (error) {
    response.publishRequired = true;
  }

  if (response.publishRequired) {
    console.log("libbluray is not published; building it...");
    await installAptPackages(["devscripts"], buildContext);
    await installAptBuildDeps(["libbluray"], buildContext);

    const buildDir = await tmp.dir({ unsafeCleanup: true });
    const srcDir = path.join(buildDir.path, "libbluray-1.2.1");

    exitCode = spawnSync(
      "apt-get",
      ["-y", "--download-only", "source", "libbluray"],
      {
        cwd: buildDir.path,
        stdio: "inherit",
      },
    ).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }

    exitCode = spawnSync("tar", ["-jxf", `libbluray_1.2.1.orig.tar.bz2`], {
      cwd: buildDir.path,
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync(
      "tar",
      ["-Jxf", `libbluray_${candidates[0]}.debian.tar.xz`],
      {
        cwd: buildDir.path,
        stdio: "inherit",
      },
    ).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    await fs.promises.unlink(
      path.join(
        buildDir.path,
        "debian",
        "patches",
        "0002-Use-system-asm-instead-of-embedded-copy.patch",
      ),
    );

    exitCode = spawnSync("sed", ["-i", "/^0002-/d", "series"], {
      cwd: path.join(buildDir.path, "debian", "patches"),
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    await fse.copy(
      path.join(buildDir.path, "debian"),
      path.join(srcDir, "debian"),
    );

    exitCode = spawnSync("dch", ["-l" + localSuffix, "Revert system asm use"], {
      cwd: srcDir,
      env: { DEBEMAIL: email },
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync("debuild", ["-b", "-uc", "-us"], {
      cwd: srcDir,
      env: { DEB_BUILD_OPTIONS: "nocheck" },
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    response.path = buildDir.path;
  }

  return response;
}

export async function runOne(
  buildContext: BuildContext,
): Promise<BuildResponse> {
  let exitCode: number | null;
  const response: BuildResponse = {
    path: path.join(ppaDebPath, "r", "run-one"),
    publishRequired: false,
  };
  try {
    const publishedRunOneFiles = await fs.promises.readdir(response.path);
    if (
      publishedRunOneFiles.some((e) => {
        return e.startsWith("run-one_");
      })
    ) {
      return response;
    } else {
      response.publishRequired = true;
    }
  } catch (error) {
    response.publishRequired = true;
  }

  if (response.publishRequired) {
    console.log("run-one is not published; building it...");
    await installAptPackages(["devscripts"], buildContext);
    const buildDir = await tmp.dir({ unsafeCleanup: true });
    const srcDir = path.join(buildDir.path, "run-one");

    exitCode = spawnSync(
      "git",
      ["clone", "https://github.com/dustinkirkland/run-one.git"],
      { cwd: buildDir.path, stdio: "inherit" },
    ).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync(
      "git",
      ["checkout", "f79197c3db602ddd639fce456bb1fa5d814b6cb7"],
      { cwd: srcDir, stdio: "inherit" },
    ).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync(
      "dch",
      ["-l" + localSuffix, "-D", buildContext.distro, "package"],
      {
        cwd: srcDir,
        env: { DEBEMAIL: email },
        stdio: "inherit",
      },
    ).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    exitCode = spawnSync("debuild", ["-b", "-uc", "-us"], {
      cwd: srcDir,
      env: { DEB_BUILD_OPTIONS: "nocheck" },
      stdio: "inherit",
    }).status;
    if (exitCode != 0) {
      process.exit(exitCode ? exitCode : 1);
    }
    response.path = buildDir.path;
  }

  return response;
}

/** Query apt-cache for candidate version(s) of a package, suitable for checking a local deb file for it matching.
 *
 * Multiple packages may be returned in case of a debian_revision on the package
 * https://www.debian.org/doc/debian-policy/ch-controlfields.html#version
 *
 * i.e. podman apt-cache policy returns a candidate like "3.0.1+dfsg1-3+b2", and
 * local builds generate a file like `podman_3.0.1+dfsg1-3${localSuffix}1_amd64.deb`.
 * In this scenario, function will return ["3.0.1+dfsg1-3+b2", "3.0.1+dfsg1-3"] so
 * the local build deb will match.
 */
export async function getPackageCandidates(
  packageName: string,
): Promise<string[]> {
  const candidates: string[] = [];
  const candidateMatch = spawnSync("apt-cache", ["policy", packageName])
    .stdout.toString()
    .match(/\s*Candidate:\s(.*)$/m);
  if (candidateMatch) {
    const candidateHasEpoch = candidateMatch[1].match(/^[0-9]*:(.*)/);
    candidates.push(
      candidateHasEpoch ? candidateHasEpoch[1] : candidateMatch[1],
    );

    const candidateDebRevisionMatch = candidates[0].match(/^(.*)\+.*$/);
    if (candidateDebRevisionMatch) {
      candidates.push(candidateDebRevisionMatch[1]);
    }
    return candidates;
  }
  console.error("Error retrieving available package version");
  process.exit(1);
}

export async function updatePackageSources(
  buildContext: BuildContext,
): Promise<void> {
  let exitCode: number | null;

  if (!buildContext.packageSourcesUpdated) {
    console.log("Running apt-get update");
    exitCode = buildContext.rootUser
      ? spawnSync("apt-get", ["update"], { stdio: "inherit" }).status
      : spawnSync("sudo", ["apt-get", "update"], { stdio: "inherit" }).status;
    if (exitCode != 0) {
      console.error(`apt-get update failed with exit code ${exitCode}`);
      process.exit(exitCode ? exitCode : 1);
    }
    buildContext.packageSourcesUpdated = true;
  }
}

export async function installAptBuildDeps(
  buildDepNames: string[],
  buildContext: BuildContext,
): Promise<void> {
  if (
    buildDepNames.every((e) => {
      return buildContext.installedBuildDeps.includes(e);
    })
  ) {
    console.debug(`Build dep(s) ${buildDepNames.join("")} already installed`);
    return;
  }
  let exitCode: number | null;

  console.log("Installing build deps for " + buildDepNames.join(" "));

  await updatePackageSources(buildContext);
  exitCode = buildContext.rootUser
    ? spawnSync("apt-get", ["build-dep", "-y"].concat(buildDepNames), {
        stdio: "inherit",
      }).status
    : spawnSync("sudo", ["apt-get", "build-dep", "-y"].concat(buildDepNames), {
        stdio: "inherit",
      }).status;
  if (exitCode != 0) {
    process.exit(exitCode ? exitCode : 1);
  }
  buildContext.installedBuildDeps.push(...buildDepNames);
}

export async function installAptPackages(
  packageNames: string[],
  buildContext: BuildContext,
): Promise<void> {
  if (
    packageNames.every((e) => {
      return buildContext.installedPackages.includes(e);
    })
  ) {
    console.debug(`Package(s) ${packageNames.join("")} already installed`);
    return;
  }
  let exitCode: number | null;

  console.log("Installing " + packageNames.join(" "));

  await updatePackageSources(buildContext);
  exitCode = buildContext.rootUser
    ? spawnSync("apt-get", ["install", "-y"].concat(packageNames), {
        stdio: "inherit",
      }).status
    : spawnSync("sudo", ["apt-get", "install", "-y"].concat(packageNames), {
        stdio: "inherit",
      }).status;
  if (exitCode != 0) {
    process.exit(exitCode ? exitCode : 1);
  }
  buildContext.installedPackages.push(...packageNames);
}

export async function getDistroCodename(): Promise<string> {
  const lsbRes = spawnSync("lsb_release", ["-sc"]);
  if (lsbRes.status != 0) {
    console.error("Error running lsb_release");
    process.exit(lsbRes.status ? lsbRes.status : 1);
  }
  return lsbRes.stdout.toString().trim();
}

/** Make HTTPS request */
export async function httpsRequest(
  params: https.RequestOptions | string | URL,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postData: any = undefined,
): Promise<string> {
  return new Promise(function (resolve, reject) {
    const req = https.request(params, function (res) {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error("Bad HTTP status code: " + res.statusCode));
      }
      let body: Uint8Array[] = [];
      let result: string = "";
      res.on("data", function (chunk) {
        body.push(chunk);
      });
      res.on("end", function () {
        try {
          result = Buffer.concat(body).toString();
        } catch (e) {
          reject(e);
        }
        resolve(result);
      });
    });
    req.on("error", function (err) {
      reject(err);
    });
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/** Return true if provided path exists */
export async function pathExists(filepath: string): Promise<boolean> {
  try {
    await fs.promises.stat(filepath);
  } catch (error) {
    return false;
  }
  return true;
}

updatePPA();
