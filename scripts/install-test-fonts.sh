#!/usr/bin/env bash
set -euo pipefail

font_archive="${RUNNER_TEMP:?}/libertine.tds.zip"
font_root="$(kpsewhich -var-value TEXMFLOCAL)"
downloaded=false
for font_url in https://ctan.math.illinois.edu/install/fonts/libertine.tds.zip https://mirrors.mit.edu/CTAN/install/fonts/libertine.tds.zip; do
  if curl --fail --location --retry 2 --max-time 120 --output "$font_archive" "$font_url"; then downloaded=true; break; fi
done
[ "$downloaded" = true ]
echo "4f06db8de016fe5e4109d7b6d4e6078b14958aca0e8528cd1d6620e9853ddba7  $font_archive" | sha256sum --check
sudo mkdir -p "$font_root"
sudo unzip -q -o "$font_archive" -d "$font_root"
sudo mktexlsr "$font_root"
sudo updmap-sys --enable Map=libertine.map
kpsewhich libertine.sty
kpsewhich --all -engine=xetex ls-R | grep -F "$font_root/ls-R"
