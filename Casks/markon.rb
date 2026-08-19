cask "markon" do
  arch arm: "aarch64", intel: "14b336d7adcb53677c343c6d670564486d5ccd4af9aef7ac5a74cd7048e06344"

  version "0.15.21"
  sha256 arm:   "1203f24fbff85953110375ce3d0e686d521b0273f9cac35bc7f370edcd786f9d",
         intel: "dba1abc6cfffa0cd54de7b608ed50e98ebc798c32f256cfa67b55a9f08f1c850"

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
