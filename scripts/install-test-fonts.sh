#!/usr/bin/env bash
set -euo pipefail

font_archive="${RUNNER_TEMP:?}/libertine.tds.zip"
font_root="${RUNNER_TEMP}/copilot-test-texmf"
curl --fail --location --retry 3 --output "$font_archive" https://mirrors.ctan.org/install/fonts/libertine.tds.zip
echo "4f06db8de016fe5e4109d7b6d4e6078b14958aca0e8528cd1d6620e9853ddba7  $font_archive" | sha256sum --check
mkdir -p "$font_root"
unzip -q -o "$font_archive" -d "$font_root"
export TEXMFHOME="$font_root"
mktexlsr "$font_root"
updmap-user --enable Map=libertine.map
echo "TEXMFHOME=$font_root" >> "${GITHUB_ENV:?}"
