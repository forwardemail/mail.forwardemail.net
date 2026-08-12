cask "forward-email" do
  version "0.12.46"

  on_arm do
    sha256 "9f783f38ddfe11286c5cb9f1abcfd0a1f318c7659b6ec32be39cd23144b9888a"

    url "https://github.com/forwardemail/mail.forwardemail.net/releases/download/v#{version}/Forward.Email_#{version}_aarch64.dmg"
  end

  on_intel do
    sha256 "f885b44bc4c9a334d7041b0bb091267d33f60cd5bce320c7875b8595d18220d9"

    url "https://github.com/forwardemail/mail.forwardemail.net/releases/download/v#{version}/Forward.Email_#{version}_x64.dmg"
  end

  name "Forward Email"
  desc "Private and secure email client"
  homepage "https://forwardemail.net"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true

  app "Forward Email.app"
end
