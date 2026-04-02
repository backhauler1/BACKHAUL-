module.exports = {
  coverageThreshold: {
    global: {
      branches: 80,    // 80% of all control flow branches (if/else, switch) must be tested
      functions: 80,   // 80% of all functions must be called during tests
      lines: 80,       // 80% of all lines of code must be executed
      statements: 80   // 80% of all statements must be executed
    }
  }
};
