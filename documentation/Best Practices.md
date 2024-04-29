# Best Practices when coding in this repository

## Imports
As per `tsconfig.json`, the root of the repository is set to `./`.
For this reason, is easy to keep all the imports sorted and tidy by avoiding relative paths such as `../mymodule.ts` and using directly `src/libs/mymodule.ts` for example.

## Interfaces
To keep everything ordered, please use the `types` folder in your subdirectory (i.e. `src/libs/blockchain/types`) and import from there. Please avoid defining and exporting interfaces all around the place.

Classes should have their own file too, while not residing in a dedicated folder.

## Linting and Formatting
`trunk` linter is used and enabled globally. Configuration should be already shipped. Alternatively, you can use `prettier-eslint`. Please avoid using other formatting tools to avoid huge "false-commits".