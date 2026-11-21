// Executable CI paths: reconcile never dispatches a conflict fix for a pull request that changes one, and the conflict
// fix never publishes a patch that changes one. Other .github/ files are data and go through the repository's gates.
const CI_PATH_PREFIXES = ['.github/workflows/', '.github/actions/'];

const isCiPath = (path) => CI_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));

module.exports = { CI_PATH_PREFIXES, isCiPath };
