cask "markon" do
  arch arm: "aarch64", intel: "x64"

  version "0.13.10"
  sha256 arm:   "b2a44830cc1f07de2d47ed2615ac1a10c59eeecd18ba0870c7db607df4c91804",
         intel: :no_check

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
