module.exports = {
  collectCoverageFrom: [
    "**/*.js",              // Start by including ALL JavaScript files in the project
    "!**/node_modules/**",  // Exclude third-party packages
    "!**/dist/**",          // Exclude compiled frontend output
    "!*.config.js"          // Exclude configuration files like this one!
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  testEnvironment: "jsdom"
};