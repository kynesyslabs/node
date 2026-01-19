import Diagnostic from "./utilities/Diagnostic"
import { SingleBar, Presets } from "cli-progress"

async function runBenchmark() {
  console.log("Initializing system benchmark...")

  const progressBar = new SingleBar({
    format: "Progress |{bar}| {percentage}% || {value}/{total} Checks\n",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
  }, Presets.shades_classic)

  try {
    const result = await Diagnostic.benchmark(progressBar)

    console.log("\nBenchmark Results:")
    console.log("------------------")

    // Determine overall status
    let overallStatus: "PASS" | "WARN" | "FAIL"
    if (result.meetsSuggested) {
      overallStatus = "PASS"
    } else if (result.meetsMinimum) {
      overallStatus = "WARN"
    } else {
      overallStatus = "FAIL"
    }

    console.log(`Overall Status: ${overallStatus}`)

    console.log("\nComponent Details:")
    for (const [component, details] of Object.entries(result.details)) {
      console.log(`  ${component.toUpperCase()}:`)

      // Determine component status
      let status: string
      if (details.meetsSuggested) {
        status = "PASS"
      } else if (details.meetsMinimum) {
        status = "WARN (below suggested)"
      } else {
        status = "FAIL (below minimum)"
      }
      console.log(`    Status: ${status}`)

      if (component === "network") {
        const networkValue = details.value as { download: number; upload: number }
        console.log(`    Download Speed: ${networkValue.download.toFixed(2)} Mbps`)
        console.log(`    Upload Speed: ${networkValue.upload.toFixed(2)} Mbps`)
      } else {
        console.log(`    Detected Value: ${(details.value as number).toFixed(2)} ${getUnit(component)}`)
      }
    }

    // Handle different status outcomes
    if (!result.meetsMinimum) {
      console.log("\n[ERROR] System does not meet MINIMUM requirements.")
      console.log("The node cannot start. Please upgrade your system.")
      console.log("Check the .requirements file for minimum specifications.")
      process.exit(1)
    } else if (!result.meetsSuggested) {
      console.log("\n[WARNING] System meets minimum but not suggested requirements.")
      console.log("The node will start, but performance may be degraded.")
      console.log("Consider upgrading to suggested specifications for optimal performance.")
      process.exit(0)
    } else {
      console.log("\n[OK] System meets all suggested requirements.")
      process.exit(0)
    }

  } catch (error) {
    console.error("Error running benchmark:", error)
    process.exit(1)
  }
}

function getUnit(component: string): string {
  switch (component.toLowerCase()) {
    case "cpu":
      return "MHz"
    case "ram":
    case "disk":
      return "GB"
    case "network":
      return "Mbps"
    default:
      return ""
  }
}

runBenchmark()
