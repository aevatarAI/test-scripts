# Aevatar Station Load Testing Tool

This tool is designed for performance and load testing of Aevatar Station, simulating multi-user concurrent access scenarios.

## Features

- Support for multi-user concurrent connection testing
- Batch session creation and message sending
- Detailed performance metrics (response time, success rate, etc.)
- Configurable test parameters
- Batch execution support to avoid instant high load
- Resource management and connection pool control
- Comprehensive error handling and logging

## Installation

```bash
# Install dependencies
npm install
```

## Usage

### Basic Usage

```bash
# Run test with default configuration
npm run benchmark
```

### Running with Parameters

```bash
# Customize user count and batch size
node benchmark.js --userCount=10 --batchSize=5

# High concurrency stress test
npm run benchmark:stress
```

### Available Command Line Parameters

| Parameter | Description | Default Value |
|-----------|-------------|---------------|
| `--baseUrl` | Server base URL | `https://station-developer-staging.aevatar.ai` |
| `--userCount` | Number of simulated users | 1 |
| `--batchSize` | Batch size | 1 |
| `--messageCount` | Number of messages per session | 1 |
| `--maxConcurrentConnections` | Maximum concurrent connections | 200 |
| `--systemLLM` | LLM model to use | "OpenAI" |
| `--getSessionIdTimeout` | Session ID acquisition timeout (ms) | 60000 |
| `--connectionTimeout` | Connection timeout (ms) | 60000 |
| `--messageResponseTimeout` | Message response timeout (ms) | 10000 |

## Test Results

Test results will be output to both console and saved in the `benchmark-results` directory. Results include:

- Session creation success rate and duration
- Message processing success rate and response time
- Response time statistical analysis (max/min/average/median/percentiles)
- System throughput metrics (messages per second)

## Development

### Running Unit Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

## Test Phase Description

The test consists of three phases:

1. **Phase 1**: Session Creation
   - Create specified number of user sessions in batches
   - Statistics on session creation success rate and duration

2. **Phase 2**: Message Processing
   - Send test messages to created sessions
   - Statistics on message processing success rate and response time

3. **Phase 3**: Session Cleanup
   - Clean up all created session resources
   - Release server resources

## Troubleshooting

If you encounter issues during testing:

1. Check network connection and server status
2. Verify configuration parameters, especially baseUrl
3. For more detailed logs, modify the log level in the code
4. Check test results and error messages in the benchmark-results directory 