$env:PATH = "d:\Verman\node_env_22\node-v22.13.0-win-x64;" + $env:PATH
$env:NODE_OPTIONS = "--no-experimental-require-module"
npm.cmd run dev -- $args
