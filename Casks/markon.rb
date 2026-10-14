cask "markon" do
  arch arm: "aarch64", intel: "x64"

  version "0.15.27"
  sha256 arm:   "b0d1880fc056bd11e4e4e2c3def18ad8d27e6ab9025c9cf90c1af6295af12eb5",
         intel: "d9c88d7b5389509c80453d689f2797071ad468cbd4355889e1fa8ed73b7e9894"

  url "https://github.com/kookyleo/markon/releases/download/v#{version}/Markon_#{version}_#{arch}.dmg",
      verified: "github.com/kookyleo/markon/"
  name "Markon"
  desc "Open source, free, and fully local Markdown review workbench"
  homepage "https://github.com/kookyleo/markon"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Markon.app"

  zap trash: [
    "~/.markon",
    "~/Library/Application Support/dev.kookyleo.markon",
    "~/Library/Caches/dev.kookyleo.markon",
    "~/Library/Preferences/dev.kookyleo.markon.plist",
    "~/Library/Saved Application State/dev.kookyleo.markon.savedState",
    "~/Library/WebKit/dev.kookyleo.markon",
  ]

  caveats <<~EOS
    Markon is ad-hoc signed. On first launch macOS may refuse to open it —
    allow it via System Settings → Privacy & Security → "Open Anyway".

    Or install skipping the Gatekeeper quarantine flag:
      brew install --cask --no-quarantine markon
  EOS
end
