# AUR packaging

This directory contains packaging templates for `lecturn-bin` and
`lecturn-nightly-bin`, using the x86_64 Lecturn AppImage from GitHub Releases.
These templates do not establish that either package is published on the AUR.
Refresh their version and checksums for a Lecturn release before building.

## Publishing

The Lecturn release workflow does not publish AUR packages automatically.
`.github/workflows/publish-aur.yml` can be run manually for a specific tag after
configuring an AUR account and `AUR_SSH_PRIVATE_KEY` for the target package. It selects the stable or nightly
package, then updates its version and checksums, builds it, regenerates `.SRCINFO`, and pushes it
to the AUR.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.0.33 \
  packaging/aur/scripts/release.sh
```
