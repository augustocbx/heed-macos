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
        // Unified microphone/system capture (no FluidAudio dependency).
        // Outputs timestamp-aligned s16le PCM at 16 kHz: mono or L=mic/R=system stereo.
        .executableTarget(
            name: "heed-syscap"
        ),
    ]
)
