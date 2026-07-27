// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-mobile-push",
  platforms: [
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-mobile-push",
      type: .static,
      targets: ["tauri-plugin-mobile-push"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-mobile-push",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
