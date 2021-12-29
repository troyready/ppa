# Personal Package Archive

This repo contains Debian packages either:

* Not built for a given distribution, or
* Missing desired patches

Configure it in the form of:

```bash
echo "deb [trusted=yes] https://troyready.github.io/ppa/debian $(lsb_release -sc) main" | sudo tee /etc/apt/sources.list.d/troyready-ppa.list >/dev/null
```

## Packages

### `libbluray-bdj`

Debian bullseye version of libbluray [has issues playing blu-rays](https://code.videolan.org/videolan/libbluray/-/issues/31) because of a custom Debian packaging patch. Fix is already [in master](https://salsa.debian.org/multimedia-team/libbluray/-/commit/a529f3b0806dc9a02bda681499041a190515ce0e), so this build will likely not be needed if a bookworm backport is published.

### `podman`

Debian bullseye version of evolution does not [fully support the python SDK for docker](https://github.com/containers/podman/issues/9564). Fix is already upstream, so this build will likely not be needed if a bookworm backport is published.

### `runone`

[Helper scripts](https://launchpad.net/run-one) for running a single occurrence of a command/script. Distributed in Ubuntu but not Debian.

### `evolution`

Debian bullseye version of evolution does not allow [editing of meetings which you do not own](https://gitlab.gnome.org/GNOME/evolution/-/issues/992). Fix is already upstream in 3.39.2+, so this build will likely not be needed if a bookworm backport is published.
