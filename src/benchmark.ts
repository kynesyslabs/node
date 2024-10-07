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
    
    console.log(`Overall Compliance: ${result.compliant ? "Pass" : "Fail"}`)
    
    console.log("\nComponent Details:")
    for (const [component, details] of Object.entries(result.details)) {
      console.log(`  ${component.toUpperCase()}:`)
      console.log(`    Status: ${details.compliant ? "Pass" : "Fail"}`)
      
      if (component === "network") {
        const networkValue = details.value as { download: number; upload: number }
        console.log(`    Download Speed: ${networkValue.download.toFixed(2)} Mbps`)
        console.log(`    Upload Speed: ${networkValue.upload.toFixed(2)} Mbps`)
      } else {
        console.log(`    Detected Value: ${(details.value as number).toFixed(2)} ${getUnit(component)}`)
      }
    }

    if (!result.compliant) {
      console.log("\nWarning: System does not meet minimum requirements.")
      console.log("Please check the .requirements file and upgrade your system if necessary.")
    }
    process.exit(0)

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
