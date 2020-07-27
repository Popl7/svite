// @ts-check

/** This script modifies the project to support TS code in .svelte files like:

  <script lang="ts">
  	export let name: string;
  </script>

  As well as validating the code for CI.
  */

/**  To work on this script:
  rm -rf test-template template && npx svite create test-template && node scripts/setupTypeScript.js test-template
*/

const fs = require("fs")
const path = require("path")
const { argv } = require("process")

const projectRoot = argv[2] || path.join(__dirname, "..")

// Add deps to pkg.json
const packageJSON = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
packageJSON.devDependencies = Object.assign(packageJSON.devDependencies, {
  "svelte-check": "^0.1.0",
  "svelte-preprocess": "^4.0.0",
  "typescript": "^3.9.3",
  "@tsconfig/svelte": "^1.0.0"
})

// Add script for checking
packageJSON.scripts = Object.assign(packageJSON.scripts, {
  "validate": "svelte-check"
})

// Write the package JSON
fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify(packageJSON, null, "  "))

// mv src/main.js to main.ts - note, we need to edit rollup.config.js for this too
const beforeMainJSPath = path.join(projectRoot, "src", "index.js")
const afterMainTSPath = path.join(projectRoot, "src", "index.ts")
fs.renameSync(beforeMainJSPath, afterMainTSPath)

// Switch the app.svelte file to use TS
const appSveltePath = path.join(projectRoot, "src", "App.svelte")
let appFile = fs.readFileSync(appSveltePath, "utf8")
appFile = appFile.replace("<script>", '<script lang="ts">')
appFile = appFile.replace("const world = 'world';", "const world: string = 'world';")
fs.writeFileSync(appSveltePath, appFile)

// Edit index.html
const appIndexPath = path.join(projectRoot, "index.html")
let appIndex = fs.readFileSync(appIndexPath, "utf8")
appIndex = appIndex.replace('src="/src/index.js"', 'src="/src/index.ts"')
fs.writeFileSync(appIndexPath, appIndex)

// Add TSConfig
const tsconfig = `{
  "extends": "@tsconfig/svelte/tsconfig.json",

  "include": ["src/**/*", "src/node_modules"],
  "exclude": ["node_modules/*", "__sapper__/*", "public/*"],
}`
const tsconfigPath =  path.join(projectRoot, "tsconfig.json")
fs.writeFileSync(tsconfigPath, tsconfig)

// Add Svelte Config
const svelteConfig = `
const preprocess = require('svelte-preprocess');
module.exports = {
  preprocess: preprocess({
    typescript: {
      // skips type checking
      transpileOnly: true,
    },
  }),
};
`
const svelteConfigPath = path.join(projectRoot, "svelte.config.js")
fs.writeFileSync(svelteConfigPath, svelteConfig)

// Delete this script, but not during testing
if (!argv[2]) {
  // Remove the script
  fs.unlinkSync(path.join(__filename))

  // Check for Mac's DS_store file, and if it's the only one left remove it
  const remainingFiles = fs.readdirSync(path.join(__dirname))
  if (remainingFiles.length === 1 && remainingFiles[0] === '.DS_store') {
    fs.unlinkSync(path.join(__dirname, '.DS_store'))
  }

  // Check if the scripts folder is empty
  if (fs.readdirSync(path.join(__dirname)).length === 0) {
    // Remove the scripts folder
    fs.rmdirSync(path.join(__dirname))
  }
}

// Adds the extension recommendation
fs.mkdirSync(path.join(projectRoot, ".vscode"))
fs.writeFileSync(path.join(projectRoot, ".vscode", "extensions.json"), `{
  "recommendations": ["svelte.svelte-vscode"]
}
`)

console.log("Converted to TypeScript.")

if (fs.existsSync(path.join(projectRoot, "node_modules"))) {
  console.log("\nYou will need to re-run your dependency manager to get started.")
}
