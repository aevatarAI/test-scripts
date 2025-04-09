const { HubConnectionBuilder, HttpTransportType, LogLevel } = require('@microsoft/signalr');
const WebSocket = require('ws');
const fetch = require('node-fetch');

// Global configuration
const CONFIG = {
  baseUrl: "https://station-developer-staging.aevatar.ai",
  hubPath: "/godgptpressure-client/api/agent/aevatarHub",
  getSessionIdTimeout: 60000, // Use milliseconds consistently
  systemLLM: "OpenAI",
  messageCount: 1,
  phaseInterval: 1000,
  clearSessionTimeout: 60000,
  connectionTimeout: 60000,
  retryCount: 3,
  retryDelay: 1000, // Increase retry delay
  messageResponseTimeout: 10000,
  phase1ToPhase2Delay: 60000,
  maxConcurrentConnections: 200,
  userCount: 1,
  batchSize: 1,
  testMessageTemplates: [
    "Test message ${index}",
    "Hello world from test client ${index}",
    "This is a longer message to test the performance with more content ${index}"
  ]
};

// Validate configuration parameters
function validateConfig() {
  if (!CONFIG.baseUrl || !CONFIG.baseUrl.startsWith('http')) {
    throw new Error('Invalid baseUrl: must be a valid URL');
  }
  
  if (CONFIG.userCount < 1) {
    throw new Error('userCount must be at least 1');
  }
  
  if (CONFIG.batchSize < 1) {
    throw new Error('batchSize must be at least 1');
  }
  
  if (CONFIG.maxConcurrentConnections < 1) {
    throw new Error('maxConcurrentConnections must be at least 1');
  }
  
  if (CONFIG.retryCount < 1) {
    throw new Error('retryCount must be at least 1');
  }
  
  console.log('Configuration validated successfully');
}

// Initialize logger
function initLogger() {
  // Replace old console methods with timestamp
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  
  console.log = function(...args) {
    const timestamp = new Date().toISOString();
    originalConsoleLog.apply(console, [`[${timestamp}] [INFO]`, ...args]);
  };
  
  console.error = function(...args) {
    const timestamp = new Date().toISOString();
    originalConsoleError.apply(console, [`[${timestamp}] [ERROR]`, ...args]);
  };
  
  console.info = function(...args) {
    const timestamp = new Date().toISOString();
    originalConsoleLog.apply(console, [`[${timestamp}] [INFO]`, ...args]);
  };
  
  console.debug = function(...args) {
    const timestamp = new Date().toISOString();
    originalConsoleLog.apply(console, [`[${timestamp}] [DEBUG]`, ...args]);
  };
}

// Test statistics object
const STATS = {
  phase1: {
    totalSessions: 0,
    successCount: 0,
    failCount: 0,
    duration: 0,
    retries: 0,
  },
  phase2: {
    totalMessages: 0,
    successCount: 0,
    failCount: 0,
    duration: 0,
    responseCount: 0,
    invalidResponseCount: 0,
    responseTimes: [],
  },
  phase3: {
    cleared: false,
    success: false,
    response: null,
    duration: 0,
  },
};

// Set global objects
globalThis.WebSocket = WebSocket;
globalThis.fetch = fetch;

class UniqueIdGenerator {
  constructor() {
    this.usedIds = new Set();
  }

  /**
   * Generate a unique ID in UUID format
   * @returns {string} Generated unique ID
   */
  generate() {
    let id;
    do {
      id = 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    } while (this.usedIds.has(id));
    this.usedIds.add(id);
    return id;
  }

  /**
   * Release an ID that is no longer in use
   * @param {string} id ID to release
   */
  release(id) {
    this.usedIds.delete(id);
  }
}

const idGenerator = new UniqueIdGenerator();
class ConnectionPool {
  constructor(maxConnections) {
    this.maxConnections = maxConnections;
    this.activeConnections = 0;
    this.queue = [];
    console.info(`Connection pool initialized with max ${maxConnections} connections`);
  }

  /**
   * Acquire a connection permit
   * @returns {Promise<void>} Promise that resolves when permit is acquired
   */
  async acquire() {
    if (this.activeConnections < this.maxConnections) {
      this.activeConnections++;
      console.debug(`Connection acquired. Active: ${this.activeConnections}/${this.maxConnections}`);
      return Promise.resolve();
    }
    console.debug(`Connection pool full (${this.activeConnections}/${this.maxConnections}). Queuing request...`);
    return new Promise(resolve => this.queue.push(resolve));
  }

  /**
   * Release a connection permit
   */
  release() {
    if (this.activeConnections > 0) {
      this.activeConnections--;
      if (this.queue.length > 0) {
        const resolve = this.queue.shift();
        console.debug(`Connection released and reused from queue. Queue length: ${this.queue.length}`);
        this.activeConnections++;
        resolve();
      } else {
        console.debug(`Connection released. Active: ${this.activeConnections}/${this.maxConnections}`);
      }
    } else {
      console.error('Attempt to release connection when no active connections exist');
    }
  }
}

const connectionPool = new ConnectionPool(CONFIG.maxConcurrentConnections);
class ClearSessionManager {
  constructor() {
    this.connection = null;
    this.manageId = idGenerator.generate();
    this.clearResolve = null;
    this.isConnected = false;
  }

  /**
   * Connect to the server
   * @returns {Promise<boolean>} Whether the connection was successful
   */
  async connect() {
    await connectionPool.acquire();
    try {
      console.info(`[ClearSessionManager ${this.manageId}] Connecting to server...`);
      this.connection = new HubConnectionBuilder()
        .withUrl(`${CONFIG.baseUrl}${CONFIG.hubPath}`, {
          transport: HttpTransportType.WebSockets,
          skipNegotiation: true,
        })
        .configureLogging(LogLevel.None)
        .withAutomaticReconnect({
          nextRetryDelayInMilliseconds: retryContext => {
            return Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 30000);
          }
        })
        .build();
      
      this.registerHandlers();
      
      await Promise.race([
        this.connection.start().then(() => {
          this.isConnected = true;
          console.info(`[ClearSessionManager ${this.manageId}] Connected successfully`);
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), CONFIG.connectionTimeout)
        )
      ]);
      
      return this.isConnected;
    } catch (error) {
      console.error(`[ClearSessionManager ${this.manageId}] Connection failed: ${error.message}`);
      return false;
    } finally {
      // If connection fails, release connection pool resources
      if (!this.isConnected) {
        connectionPool.release();
      }
    }
  }

  /**
   * Register event handlers
   */
  registerHandlers() {
    this.connection.on('ReceiveResponse', (message) => {
      console.debug(`[ClearSessionManager ${this.manageId}] Received response: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
      
      try {
        const parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
        if (parsedMessage?.IsSuccess === true && parsedMessage?.Response?.ResponseType === 7 && this.clearResolve) {
          console.info(`[ClearSessionManager ${this.manageId}] Clear sessions succeeded`);
          this.clearResolve({
            success: true,
            response: parsedMessage
          });
          this.clearResolve = null;
        }
      } catch (error) {
        console.error(`[ClearSessionManager ${this.manageId}] Error parsing response: ${error.message}`);
        if (this.clearResolve) {
          this.clearResolve({
            success: false,
            response: { error: "Invalid response format", originalError: error.message }
          });
          this.clearResolve = null;
        }
      }
    });
    
    this.connection.onclose((error) => {
      console.info(`[ClearSessionManager ${this.manageId}] Connection closed${error ? ': ' + error.message : ''}`);
      this.isConnected = false;
      
      if (this.clearResolve) {
        this.clearResolve({ 
          success: false, 
          response: { error: error ? `Connection closed: ${error.message}` : "Connection closed" } 
        });
        this.clearResolve = null;
      }
      
      // Release connection pool resources
      connectionPool.release();
    });
    
    this.connection.onreconnecting((error) => {
      console.info(`[ClearSessionManager ${this.manageId}] Reconnecting${error ? ': ' + error.message : ''}`);
    });
    
    this.connection.onreconnected((connectionId) => {
      console.info(`[ClearSessionManager ${this.manageId}] Reconnected with ID: ${connectionId}`);
      this.isConnected = true;
    });
  }

  /**
   * Clear all sessions
   * @returns {Promise<{success: boolean, response: Object}>} Result of the clear operation
   */
  async clearAllSessions() {
    if (!this.isConnected) {
      return { success: false, response: { error: "Not connected" } };
    }
    
    console.info(`[ClearSessionManager ${this.manageId}] Clearing all sessions...`);
    
    return new Promise((resolve) => {
      let timeoutCleared = false;
      const timeout = setTimeout(() => {
        if (!timeoutCleared && this.clearResolve) {
          console.error(`[ClearSessionManager ${this.manageId}] Clear session timeout after ${CONFIG.clearSessionTimeout}ms`);
          resolve({ success: false, response: { error: "Clear session timeout" } });
          this.clearResolve = null;
        }
      }, CONFIG.clearSessionTimeout);
      
      this.clearResolve = (result) => {
        if (!timeoutCleared) {
          clearTimeout(timeout);
          timeoutCleared = true;
          resolve(result);
        }
      };
      
      this.connection.invoke(
        'SubscribeAsync',
        `Aevatar.Application.Grains.Agents.ChatManager.ChatGAgentManager/${this.manageId}`,
        'Aevatar.Application.Grains.Agents.ChatManager.RequestClearAllEvent',
        JSON.stringify({})
      ).catch(error => {
        if (!timeoutCleared) {
          console.error(`[ClearSessionManager ${this.manageId}] Error invoking clear: ${error.message}`);
          clearTimeout(timeout);
          timeoutCleared = true;
          resolve({ success: false, response: { error: error.message } });
        }
      });
    });
  }

  /**
   * Disconnect and release resources
   */
  async disconnect() {
    if (this.connection) {
      console.info(`[ClearSessionManager ${this.manageId}] Disconnecting...`);
      try {
        await this.connection.stop();
        console.info(`[ClearSessionManager ${this.manageId}] Disconnected successfully`);
      } catch (error) {
        console.error(`[ClearSessionManager ${this.manageId}] Error during disconnect: ${error.message}`);
      }
      
      // Ensure connection pool resources are released
      if (this.isConnected) {
        this.isConnected = false;
        connectionPool.release();
      }
      
      // Release ID
      idGenerator.release(this.manageId);
    }
  }
}

class SessionCreator {
  constructor() {
    this.manageId = idGenerator.generate();
    this.connection = null;
    this.sessionId = null;
    this.sessionResolve = null;
    this.sessionReject = null;
    this.isConnected = false;
    this.sessionTimeout = null;
  }

  /**
   * Create a new session
   * @returns {Promise<Object>} Object containing session information
   */
  async createSession() {
    let lastError = null;
    const startTime = Date.now();
    console.info(`[SessionCreator ${this.manageId}] Starting session creation at ${new Date(startTime).toISOString()}`);
    
    for (let attempt = 1; attempt <= CONFIG.retryCount; attempt++) {
      await connectionPool.acquire();
      try {
        console.info(`[SessionCreator ${this.manageId}] Attempt ${attempt}/${CONFIG.retryCount} to create session`);
        
        this.connection = new HubConnectionBuilder()
          .withUrl(`${CONFIG.baseUrl}${CONFIG.hubPath}`, {
            transport: HttpTransportType.WebSockets,
            skipNegotiation: true,
          })
          .configureLogging(LogLevel.None)
          .withAutomaticReconnect({
            nextRetryDelayInMilliseconds: retryContext => {
              return Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 30000);
            }
          })
          .build();
          
        this.registerHandlers();
        
        await Promise.race([
          this.connection.start().then(() => {
            this.isConnected = true;
            console.info(`[SessionCreator ${this.manageId}] Connected successfully`);
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), CONFIG.connectionTimeout)
          )
        ]);
        
        this.sessionId = await new Promise((resolve, reject) => {
          this.sessionResolve = resolve;
          this.sessionReject = reject;
          
          // Set session creation timeout
          this.sessionTimeout = setTimeout(() => {
            reject(new Error('Get sessionId timeout'));
          }, CONFIG.getSessionIdTimeout);
          
          this.sendCreateSessionRequest().catch(error => {
            clearTimeout(this.sessionTimeout);
            reject(error);
          });
        });
        
        // Session creation successful
        const elapsed = Date.now() - startTime;
        console.info(`[SessionCreator ${this.manageId}] Session created successfully, ID: ${this.sessionId}, Time: ${elapsed}ms`);
        STATS.phase1.successCount++;
        
        return {
          manageId: this.manageId,
          sessionId: this.sessionId,
          connection: this.connection,
          startTime: startTime,
          creationTime: elapsed
        };
      } catch (error) {
        lastError = error;
        STATS.phase1.retries++;
        console.error(`[SessionCreator ${this.manageId}] Session creation failed: ${error.message}`);
        
        // Clean up resources
        if (this.sessionTimeout) {
          clearTimeout(this.sessionTimeout);
          this.sessionTimeout = null;
        }
        
        if (this.connection) {
          try {
            await this.connection.stop();
            console.info(`[SessionCreator ${this.manageId}] Connection stopped after failure`);
          } catch (stopError) {
            console.error(`[SessionCreator ${this.manageId}] Error stopping connection: ${stopError.message}`);
          }
          this.connection = null;
        }
        
        if (this.isConnected) {
          this.isConnected = false;
        }
        
        connectionPool.release();
        
        if (attempt < CONFIG.retryCount) {
          console.info(`[SessionCreator ${this.manageId}] Retrying in ${CONFIG.retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay));
        }
      }
    }
    
    // All retries failed
    console.error(`[SessionCreator ${this.manageId}] All ${CONFIG.retryCount} attempts to create session failed`);
    throw lastError || new Error('Session creation failed after all retry attempts');
  }

  /**
   * Register event handlers
   */
  registerHandlers() {
    this.connection.on('ReceiveResponse', (message) => {
      console.debug(`[SessionCreator ${this.manageId}] Received response: ${typeof message === 'string' ? message.substring(0, 100) + '...' : JSON.stringify(message).substring(0, 100) + '...'}`);
      
      try {
        const parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
        if (parsedMessage?.IsSuccess && parsedMessage.Response?.SessionId && this.sessionResolve) {
          clearTimeout(this.sessionTimeout);
          this.sessionResolve(parsedMessage.Response.SessionId);
          this.sessionResolve = null;
          this.sessionReject = null;
        }
      } catch (error) {
        console.error(`[SessionCreator ${this.manageId}] Error parsing response: ${error.message}`);
        if (this.sessionReject) {
          clearTimeout(this.sessionTimeout);
          this.sessionReject(new Error(`Invalid response format: ${error.message}`));
          this.sessionResolve = null;
          this.sessionReject = null;
        }
      }
    });

    this.connection.onclose((error) => {
      console.info(`[SessionCreator ${this.manageId}] Connection closed${error ? ': ' + error.message : ''}`);
      this.isConnected = false;
      
      if (this.sessionReject) {
        clearTimeout(this.sessionTimeout);
        this.sessionReject(new Error(`Connection closed${error ? ': ' + error.message : ''}`));
        this.sessionResolve = null;
        this.sessionReject = null;
      }
      
      // Release connection pool resources
      connectionPool.release();
    });

    this.connection.onreconnecting((error) => {
      console.info(`[SessionCreator ${this.manageId}] Reconnecting${error ? ': ' + error.message : ''}`);
    });
    
    this.connection.onreconnected((connectionId) => {
      console.info(`[SessionCreator ${this.manageId}] Reconnected with ID: ${connectionId}`);
      this.isConnected = true;
    });
  }

  /**
   * Send create session request
   * @returns {Promise<void>}
   */
  async sendCreateSessionRequest() {
    const params = {
      SystemLLM: CONFIG.systemLLM,
      Prompt: ''
    };
    
    console.info(`[SessionCreator ${this.manageId}] Sending create session request with LLM: ${CONFIG.systemLLM}`);
    
    await this.connection.invoke(
      'SubscribeAsync',
      `Aevatar.Application.Grains.Agents.ChatManager.ChatGAgentManager/${this.manageId}`,
      'Aevatar.Application.Grains.Agents.ChatManager.RequestCreateGodChatEvent',
      JSON.stringify(params)
    );
  }
}

class MessageSender {
  constructor(sessionInfo) {
    this.manageId = sessionInfo.manageId;
    this.sessionId = sessionInfo.sessionId;
    this.connection = sessionInfo.connection;
    this.pendingMessages = new Map(); // Track pending messages
    this.responseCallbacks = new Map(); // Response callbacks
    this.responseTimeouts = new Map(); // Response timeout handlers

    // Register response handlers
    this.messageSenderResponseHandlers();
  }

  /**
   * Message send response handler
   */
  messageSenderResponseHandlers() {
    this.connection.on('ReceiveResponse', (message) => {
      try {
        const parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
        console.debug(`[MessageSender ${this.manageId}] Received response: ${JSON.stringify(parsedMessage).substring(0, 100)}...`);

        // Logic removed for not using requestId anymore
        if (parsedMessage.IsSuccess) {
          STATS.phase2.successCount++;
        } else {
          console.error(`[MessageSender ${this.manageId}] Failed: ${JSON.stringify(parsedMessage.Error || {})}`);
          STATS.phase2.invalidResponseCount++;
        }
      } catch (error) {
        console.error(`[MessageSender ${this.manageId}] Error processing response: ${error.message}`);
      }
    });
  }

  /**
   * Send all messages
   * @returns {Promise<void[]>} Promise of all message send results
   */
  async sendMessages() {
    console.info(`[MessageSender ${this.manageId}] Sending ${CONFIG.messageCount} messages`);

    const messagePromises = Array.from({ length: CONFIG.messageCount }, (_, i) =>
      this.sendSingleMessage(i)
    );

    return Promise.all(messagePromises);
  }

  /**
   * Send a single message
   * @param {number} index Message index
   * @returns {Promise<Object>} Message response promise
   */
  async sendSingleMessage(index) {
    // Select a message content from template
    const templateIndex = index % CONFIG.testMessageTemplates.length;
    const messageContent = CONFIG.testMessageTemplates[templateIndex].replace('${index}', index + 1);
    const startTime = Date.now();

    console.info(`[MessageSender ${this.manageId}] Sending message ${index + 1}: "${messageContent.substring(0, 30)}..."`);
    return new Promise((resolve, reject) => {
      // Set response timeout
      const timeout = setTimeout(() => {
        console.error(`[MessageSender ${this.manageId}] Message ${index + 1} timed out after ${CONFIG.messageResponseTimeout}ms`);
        STATS.phase2.failCount++;
        resolve({ success: false, error: 'Timeout', index });
      }, CONFIG.messageResponseTimeout);

      // Send message
      this.connection.invoke(
        'SubscribeAsync',
        `Aevatar.Application.Grains.Agents.ChatManager.ChatGAgentManager/${this.manageId}`,
        'Aevatar.Application.Grains.Agents.ChatManager.RequestStreamGodChatEvent',
        JSON.stringify({
          SessionId: this.sessionId,
          systemLLM: CONFIG.systemLLM,
          Content: messageContent
        })
      ).then(response => {
        clearTimeout(timeout);
        STATS.phase2.responseTimes.push(Date.now() - startTime);
        STATS.phase2.responseCount++;
        STATS.phase2.totalMessages++;
        resolve({ success: true, index });
      }).catch(error => {
        console.error(`[MessageSender ${this.manageId}] Error sending message ${index + 1}: ${error.message}`);
        clearTimeout(timeout);
        STATS.phase2.failCount++;
        resolve({ success: false, error: error.message, index });
      });
    });
  }
  
  /**
   * Clean up all timeout handlers
   */
  cleanup() {
    // Clean up all timeout handlers
    for (const timeoutId of this.responseTimeouts.values()) {
      clearTimeout(timeoutId);
    }

    this.responseTimeouts.clear();
    this.pendingMessages.clear();
    this.responseCallbacks.clear();
  }
}

/**
 * Run tests in batches
 * @returns {Promise<void>}
 */
async function runTestsInBatches() {
  const batches = Math.ceil(CONFIG.userCount / CONFIG.batchSize);
  const allSessions = [];
  const phase1StartTime = Date.now();
  console.info(`Starting Phase 1: Creating sessions in ${batches} batches at ${new Date(phase1StartTime).toISOString()}`);
  for (let i = 0; i < batches; i++) {
    const usersInBatch = Math.min(CONFIG.batchSize, CONFIG.userCount - (i * CONFIG.batchSize));
    console.info(`Processing batch ${i + 1}/${batches} with ${usersInBatch} users`);

    const creators = Array.from({ length: usersInBatch }, () => new SessionCreator());
    const sessionResults = await Promise.allSettled(creators.map(creator => creator.createSession()));
    const successfulSessions = sessionResults
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value);
    const failedCount = sessionResults.filter(result => result.status === 'rejected').length;

    STATS.phase1.totalSessions += usersInBatch;
    STATS.phase1.failCount += failedCount;
    allSessions.push(...successfulSessions);
    console.info(`Batch ${i + 1} complete: Created ${successfulSessions.length} sessions, Failed: ${failedCount}`);

    if (i < batches - 1) {
      console.info(`Waiting ${CONFIG.phaseInterval}ms before starting next batch...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.phaseInterval));
    }
  }

  const phase1EndTime = Date.now();
  STATS.phase1.duration = (phase1EndTime - phase1StartTime) / 1000;
  console.info(`Phase 1 Complete at ${new Date(phase1EndTime).toISOString()}`);
  console.info(`Sessions created: ${allSessions.length} of ${CONFIG.userCount} (${(allSessions.length / CONFIG.userCount * 100).toFixed(2)}%)`);
  if (allSessions.length === 0) {
    console.error('No sessions were created successfully. Aborting test.');
    return;
  }
  console.info(`Waiting ${CONFIG.phase1ToPhase2Delay / 1000} seconds before starting Phase 2...`);
  await new Promise(resolve => setTimeout(resolve, CONFIG.phase1ToPhase2Delay));
  console.info(`Starting Phase 2: Sending messages to ${allSessions.length} sessions...`);
  const phase2StartTime = Date.now();
  const senders = allSessions.map(session => new MessageSender(session));
  const messageResults = await Promise.allSettled(senders.map(sender => sender.sendMessages()));

  const phase2EndTime = Date.now();
  STATS.phase2.duration = (phase2EndTime - phase2StartTime) / 1000;
  console.info(`Phase 2 Complete at ${new Date(phase2EndTime).toISOString()}`);
  calculateOverallResponseStatistics();
}

/**
 * Calculate response statistics
 */
function calculateOverallResponseStatistics() {
  const responseTimes = STATS.phase2.responseTimes;
  if (responseTimes.length > 0) {
    // Basic statistics
    STATS.phase2.maxResponseTime = Math.max(...responseTimes);
    STATS.phase2.minResponseTime = Math.min(...responseTimes);
    STATS.phase2.avgResponseTime = responseTimes.reduce((a, b) => a + b) / responseTimes.length;
    
    // Sort time array for median and percentile calculations
    const sortedTimes = [...responseTimes].sort((a, b) => a - b);
    const midIndex = Math.floor(sortedTimes.length / 2);
    
    // Calculate median
    STATS.phase2.medianResponseTime = sortedTimes.length % 2 === 0
      ? (sortedTimes[midIndex - 1] + sortedTimes[midIndex]) / 2
      : sortedTimes[midIndex];
    
    // Calculate 90th and 95th percentile response times
    const p90Index = Math.floor(sortedTimes.length * 0.9);
    const p95Index = Math.floor(sortedTimes.length * 0.95);
    STATS.phase2.p90ResponseTime = sortedTimes[p90Index];
    STATS.phase2.p95ResponseTime = sortedTimes[p95Index];
    
    // Calculate message rate
    STATS.phase2.messagesPerSecond = STATS.phase2.responseCount / STATS.phase2.duration;
    
    console.info('Overall Message response statistics:');
    console.info(`Total messages processed: ${STATS.phase2.responseCount}`);
    console.info(`Max response time: ${STATS.phase2.maxResponseTime}ms`);
    console.info(`Min response time: ${STATS.phase2.minResponseTime}ms`);
    console.info(`Avg response time: ${STATS.phase2.avgResponseTime.toFixed(2)}ms`);
    console.info(`Median response time: ${STATS.phase2.medianResponseTime.toFixed(2)}ms`);
    console.info(`90th percentile response time: ${STATS.phase2.p90ResponseTime}ms`);
    console.info(`95th percentile response time: ${STATS.phase2.p95ResponseTime}ms`);
    console.info(`Processing rate: ${STATS.phase2.messagesPerSecond.toFixed(2)} messages/second`);
  } else {
    console.warn('No message response times recorded');
    STATS.phase2.maxResponseTime = 0;
    STATS.phase2.minResponseTime = 0;
    STATS.phase2.avgResponseTime = 0;
    STATS.phase2.medianResponseTime = 0;
    STATS.phase2.p90ResponseTime = 0;
    STATS.phase2.p95ResponseTime = 0;
    STATS.phase2.messagesPerSecond = 0;
  }
}

/**
 * Print test statistics
 */
function printStats() {
  console.info('\n📊 Test Statistics:');
  console.info('=== Phase 1: Session Creation ===');
  console.info(`Total sessions attempted: ${STATS.phase1.totalSessions}`);
  console.info(`Success count: ${STATS.phase1.successCount}`);
  console.info(`Failure count: ${STATS.phase1.failCount}`);
  console.info(`Retry count: ${STATS.phase1.retries}`);
  const phase1SuccessRate = STATS.phase1.totalSessions > 0
    ? (STATS.phase1.successCount / STATS.phase1.totalSessions * 100).toFixed(2)
    : 0;
  console.info(`Success rate: ${phase1SuccessRate}%`);
  console.info(`Duration: ${STATS.phase1.duration.toFixed(2)} seconds`);

  console.info('\n=== Phase 2: Message Processing ===');
  console.info(`Total messages sent: ${STATS.phase2.totalMessages}`);
  console.info(`Successful sends: ${STATS.phase2.successCount}`);
  console.info(`Failed sends: ${STATS.phase2.failCount}`);
  console.info(`Valid responses received: ${STATS.phase2.responseCount}`);
  console.info(`Invalid response count: ${STATS.phase2.invalidResponseCount}`);
  const phase2SuccessRate = STATS.phase2.totalMessages > 0
    ? (STATS.phase2.responseCount / STATS.phase2.totalMessages * 100).toFixed(2)
    : 0;
  console.info(`Response success rate: ${phase2SuccessRate}%`);
  console.info(`Max response time: ${STATS.phase2.maxResponseTime || 0} ms`);
  console.info(`Min response time: ${STATS.phase2.minResponseTime || 0} ms`);
  console.info(`Avg response time: ${(STATS.phase2.avgResponseTime || 0).toFixed(2)} ms`);
  console.info(`Median response time: ${(STATS.phase2.medianResponseTime || 0).toFixed(2)} ms`);
  console.info(`90th percentile response time: ${STATS.phase2.p90ResponseTime || 0} ms`);
  console.info(`95th percentile response time: ${STATS.phase2.p95ResponseTime || 0} ms`);
  console.info(`Processing rate: ${(STATS.phase2.messagesPerSecond || 0).toFixed(2)} messages/second`);
  console.info(`Duration: ${STATS.phase2.duration.toFixed(2)} seconds`);

  // Third phase statistics
  console.info('\n=== Phase 3: Cleanup ===');
  console.info(`Cleared attempt: ${STATS.phase3.cleared ? 'Yes' : 'No'}`);
  console.info(`Clear result: ${STATS.phase3.success ? 'Success' : 'Failure'}`);
  if (!STATS.phase3.success && STATS.phase3.response) {
    console.info(`Error details: ${JSON.stringify(STATS.phase3.response, null, 2)}`);
  }
  console.info(`Duration: ${STATS.phase3.duration.toFixed(2)} seconds`);
}

/**
 * Run clear session phase
 * @returns {Promise<void>}
 */
async function runClearSession() {
  console.info('Starting Phase 3: Cleaning up sessions...');
  const clearManager = new ClearSessionManager();
  const startTime = Date.now();
  try {
    const connected = await clearManager.connect();
    if (!connected) {
      console.error('Failed to connect for session cleanup');
      STATS.phase3.cleared = false;
      STATS.phase3.success = false;
      STATS.phase3.response = { error: "Connection failed" };
      return;
    }

    STATS.phase3.cleared = true;
    console.info('Connection established, clearing all sessions...');
    
    const result = await clearManager.clearAllSessions();
    STATS.phase3.success = result.success ||
      (result.response?.IsSuccess === true && result.response?.Response?.ResponseType === 7);
    STATS.phase3.response = result.response;
    
    console.info(`Session cleanup ${STATS.phase3.success ? 'succeeded' : 'failed'}`);
  } catch (error) {
    console.error(`Error during session cleanup: ${error.message}`);
    STATS.phase3.success = false;
    STATS.phase3.response = { error: error.message };
  } finally {
    await clearManager.disconnect();
  }
}

/**
 * Parse command line arguments and update configuration
 */
function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (value !== undefined && key in CONFIG) {
        // Convert value to the correct type
        if (typeof CONFIG[key] === 'number') {
          CONFIG[key] = Number(value);
        } else if (typeof CONFIG[key] === 'boolean') {
          CONFIG[key] = value.toLowerCase() === 'true';
        } else {
          CONFIG[key] = value;
        }
        console.info(`Config override: ${key} = ${CONFIG[key]}`);
      }
    }
  }
}

/**
 * Run test
 * @returns {Promise<void>}
 */
async function runTest() {
  // Initialize
  initLogger();
  parseCommandLineArgs();
  validateConfig();
  
  console.info(`🚀 Starting benchmark test with ${CONFIG.userCount} concurrent users`);
  console.info(`Server: ${CONFIG.baseUrl}${CONFIG.hubPath}`);
  console.info(`System LLM: ${CONFIG.systemLLM}`);
  console.info(`Batch size: ${CONFIG.batchSize}`);
  console.info(`Message count per session: ${CONFIG.messageCount}`);
  console.info(`Maximum concurrent connections: ${CONFIG.maxConcurrentConnections}`);
  
  const startTime = Date.now();
  
  try {
    await runTestsInBatches();
    await runClearSession();
    
    const endTime = Date.now();
    const totalDuration = (endTime - startTime) / 1000;
    
    printStats();
    console.info(`\n🎉 Test completed in ${totalDuration.toFixed(2)} seconds`);
    
    return {
      success: true,
      stats: STATS,
      duration: totalDuration
    };
  } catch (error) {
    console.error(`Test failed: ${error.message}`);
    console.error(error.stack);
    
    // Try to print collected statistics
    printStats();
    
    return {
      success: false,
      error: error.message,
      stats: STATS,
      duration: (Date.now() - startTime) / 1000
    };
  }
}

/**
 * Save test results to a file
 * @param {Object} results Test results
 */
function saveResultsToFile(results) {
  const fs = require('fs');
  const path = require('path');
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = path.join(process.cwd(), 'benchmark-results');
  
  // Ensure the directory exists
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  
  const resultsFilePath = path.join(resultsDir, `benchmark-${timestamp}.json`);
  
  // Prepare result data
  const data = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    results: results
  };
  
  // Write to file
  fs.writeFileSync(resultsFilePath, JSON.stringify(data, null, 2));
  console.info(`Results saved to ${resultsFilePath}`);
}

// Export at the end of the file
module.exports = {
  CONFIG,
  STATS,
  UniqueIdGenerator,
  ConnectionPool,
  ClearSessionManager,
  SessionCreator,
  MessageSender,
  validateConfig,
  initLogger,
  calculateOverallResponseStatistics,
  printStats,
  runClearSession,
  runTestsInBatches,
  runTest,
  saveResultsToFile,
  parseCommandLineArgs
};

/**
 * Main function
 */
async function main() {
  try {
    const results = await runTest();
    saveResultsToFile(results);
    
    process.exit(results.success ? 0 : 1);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the test
main();

// Handle exit signal
process.on('SIGINT', async () => {
  console.info("\n👋 Shutting down gracefully...");
  printStats();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error("\n💥 Uncaught exception:", error);
  printStats();
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error("\n💥 Unhandled promise rejection:", reason);
  printStats();
  process.exit(1);
});