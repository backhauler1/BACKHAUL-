module.exports = {
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/dist/"
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  }
};