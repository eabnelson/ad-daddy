// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ad-daddy-device-key-helper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ad-daddy-device-key-helper", targets: ["AdDaddyDeviceKeyHelper"]),
    ],
    targets: [
        .executableTarget(name: "AdDaddyDeviceKeyHelper"),
    ]
)
