// swift-tools-version:5.9
import PackageDescription

// heed-parakeet: resident Swift sidecar that runs Parakeet ASR + FluidAudio speaker
// diarization on the Apple Neural Engine. heed (Python) spawns it once and talks to it
// over a tiny newline-delimited JSON protocol on stdin/stdout. Apple Silicon only.
let package = Package(
    name: "heed-parakeet",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.0"),
    ],
    targets: [
        .executableTarget(
            name: "heed-parakeet",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        ),
        // System-audio capture via ScreenCaptureKit (no FluidAudio dep → fast build).
        // Outputs raw s16le 16kHz mono PCM; the Node server merges it with the mic.
        .executableTarget(
            name: "heed-syscap"
        ),
    ]
)
