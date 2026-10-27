cask "markon" do
  arch arm: "aarch64", intel: "x64"

  version "0.15.29"
  sha256 arm:   "96011e53f2a8856ac71c27a6a3e7918de206596aff19328f66172cc86287fd86",
         intel: "ee4b74c3cdd7ccd939da3ab7ea85f5580063f2c2b2a3db27fb54de770b321170"

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
