const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const Twilio = require("twilio");
const crypto = require("crypto");

// Load env from project root .env
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Environment variable mapping with fallbacks
function envOr(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim() !== '') return v.trim();
  }
  return '';
}

function getTwilioEnv() {
  const ACCOUNT_SID = envOr('TWILIO_ACCOUNT_SID', 'ACCOUNT_SID');
  const API_KEY     = envOr('TWILIO_API_KEY', 'TWILIO_API_KEY_SID');      // accept either
  const API_SECRET  = envOr('TWILIO_API_SECRET', 'TWILIO_API_KEY_SECRET'); // accept either
  const APP_SID     = envOr('TWILIO_TWIML_APP_SID', 'TWIML_APP_SID');
  const CALLER_ID   = envOr('TWILIO_VOICE_CALLER_ID', 'CALLER_ID');

  // one-time log on startup to see what's actually loaded
  if (!global.__TWILIO_ENV_LOGGED__) {
    global.__TWILIO_ENV_LOGGED__ = true;
    console.log('TWILIO ENV CHECK', {
      ACCOUNT_SID: ACCOUNT_SID ? 'set' : 'missing',
      API_KEY:     API_KEY ? 'set' : 'missing',
      API_SECRET:  API_SECRET ? 'set' : 'missing',
      APP_SID:     APP_SID ? 'set' : 'missing',
      CALLER_ID:   CALLER_ID ? 'set' : 'missing',
      // optional lengths to ensure not whitespace
      _debug: {
        API_KEY_len: API_KEY?.length || 0,
        API_SECRET_len: API_SECRET?.length || 0,
      }
    });
  }

  return { ACCOUNT_SID, API_KEY, API_SECRET, APP_SID, CALLER_ID };
}

// Twilio token pieces
const { jwt } = Twilio;
const AccessToken = jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const app = express();
app.set("trust proxy", 1);

// Security
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Body parsing (Twilio webhooks use urlencoded)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS (frontend during local dev)
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173").split(",");
app.use(cors({
  origin: (origin, cb) => {
    // Allow all localhost origins for development
    if (!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    console.log('CORS blocked origin:', origin);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Logging
const logFormat = process.env.NODE_ENV === "production" ? "combined" : "dev";
app.use(morgan(logFormat));

// Rate limiting for API
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use("/api/", limiter);

// Validate required configuration
function ensureEnv(requiredKeys) {
  const missing = requiredKeys.filter((k) => !process.env[k]);
  if (missing.length) return `Missing required env vars: ${missing.join(', ')}`;
  return null;
}

// Optional Twilio client (if you also need server-initiated calls)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Health check
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// --- Twilio Voice Access Token endpoint ---
app.get('/api/token', (req, res) => {
  try {
    const { ACCOUNT_SID, API_KEY, API_SECRET, APP_SID } = getTwilioEnv();

    const missing = [];
    if (!ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
    if (!API_KEY)     missing.push('TWILIO_API_KEY (or TWILIO_API_KEY_SID)');
    if (!API_SECRET)  missing.push('TWILIO_API_SECRET (or TWILIO_API_KEY_SECRET)');
    if (!APP_SID)     missing.push('TWILIO_TWIML_APP_SID');
    if (missing.length) {
      return res.status(500).json({ error: 'Missing Twilio env vars', missing });
    }

    const identity = req.query.identity || `user_${Math.random().toString(16).slice(2,10)}`;
    const ttl = Number(process.env.TOKEN_TTL_SECONDS || 3600);

    const token = new AccessToken(ACCOUNT_SID, API_KEY, API_SECRET, { identity, ttl });
    const grant = new VoiceGrant({
      outgoingApplicationSid: APP_SID,
      incomingAllow: true,
    });
    token.addGrant(grant);

    return res.json({ token: token.toJwt(), identity, ttl });
  } catch (err) {
    console.error('Token error detail:', err?.message, err?.stack);
    return res.status(500).json({ error: 'Token generation failed', detail: String(err?.message || err) });
  }
});

// 2) TwiML responses for outgoing calls
app.post("/api/voice/outgoing", (req, res, next) => {
  try {
    const envErr = ensureEnv(["TWILIO_TWIML_APP_SID", "CALLER_ID"]);
    if (envErr) return res.status(500).type("text/xml").send(`<Response><Say>${envErr}</Say></Response>`);

    const twiml = new Twilio.twiml.VoiceResponse();
    const callerId = process.env.CALLER_ID;
    const to = req.body.To || req.body.to || req.body.phoneNumber || "";
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:5001";

    console.log("TwiML request:", { to, callerId, body: req.body });

    if (!to) {
      const dial = twiml.dial({ callerId });
      dial.client("client");
    } else if (/^[\d+*#]+$/.test(to)) {
      const dial = twiml.dial({ 
        callerId,
        record: 'record-from-answer',
        recordingChannels: 'dual',
        recordingStatusCallback: `${publicBaseUrl}/api/voice/recording-status`,
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: 'completed'
      }, to);
      
      // Add transcription configuration to the dial
      dial.record({
        transcribe: true,
        transcriptionEngine: 'enhanced',
        transcriptionCallback: `${publicBaseUrl}/api/voice/transcription-status`,
        transcriptionCallbackMethod: 'POST'
      });
    } else {
      const dial = twiml.dial({ 
        callerId,
        record: 'record-from-answer',
        recordingChannels: 'dual',
        recordingStatusCallback: `${publicBaseUrl}/api/voice/recording-status`,
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: 'completed'
      });
      dial.client(to);
      
      // Add transcription configuration to the dial
      dial.record({
        transcribe: true,
        transcriptionEngine: 'enhanced',
        transcriptionCallback: `${publicBaseUrl}/api/voice/transcription-status`,
        transcriptionCallbackMethod: 'POST'
      });
    }

    const twimlResponse = twiml.toString();
    console.log("TwiML response:", twimlResponse);
    res.type("text/xml").send(twimlResponse);
  } catch (err) { 
    console.error("TwiML error:", err);
    next(err); 
  }
});

// 3) Call status management with optional signature validation
function isValidTwilioRequest(req) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const signature = req.headers["x-twilio-signature"]; 
    const publicBaseUrl = process.env.PUBLIC_BASE_URL; // e.g., https://yourdomain.com
    if (!authToken || !signature || !publicBaseUrl) return true; // skip validation if not configured
    const url = publicBaseUrl.replace(/\/$/, "") + req.originalUrl;
    return Twilio.validateRequest(authToken, signature, url, req.body || {});
  } catch (_) { return false; }
}

app.post("/api/voice/status", express.urlencoded({ extended: false }), (req, res, next) => {
  try {
    if (!isValidTwilioRequest(req)) return res.status(403).json({ error: "Invalid Twilio signature" });
    const { CallSid, CallStatus, From, To, Direction, Timestamp } = req.body || {};
    console.log("[Twilio Status]", { CallSid, CallStatus, From, To, Direction, Timestamp });
    res.status(204).end();
  } catch (err) { next(err); }
});

// 4) Recording status callback endpoint
app.post("/api/voice/recording-status", express.urlencoded({ extended: false }), (req, res, next) => {
  try {
    if (!isValidTwilioRequest(req)) return res.status(403).json({ error: "Invalid Twilio signature" });
    
    const { 
      RecordingSid, 
      RecordingUrl, 
      RecordingDuration, 
      RecordingChannels,
      CallSid,
      RecordingStatus,
      RecordingStartTime,
      RecordingEndTime
    } = req.body || {};
    
    console.log("[Recording Status]", { 
      RecordingSid, 
      RecordingUrl, 
      RecordingDuration, 
      RecordingChannels,
      CallSid,
      RecordingStatus,
      RecordingStartTime,
      RecordingEndTime
    });
    
    // Store recording metadata (in production, use a database)
    const recording = {
      sid: RecordingSid,
      url: RecordingUrl,
      duration: RecordingDuration,
      channels: RecordingChannels,
      callSid: CallSid,
      status: RecordingStatus,
      startTime: RecordingStartTime,
      endTime: RecordingEndTime,
      createdAt: new Date().toISOString()
    };
    
    // Store in memory (use database in production)
    recordings.set(RecordingSid, recording);
    console.log("[Recording Saved]", recording);
    
    // Update contact profile and conversation history
    const phoneNumber = CallSid; // In a real app, extract phone number from call data
    if (phoneNumber) {
      updateContactProfile(phoneNumber, { duration: RecordingDuration });
      addConversationEntry(phoneNumber, {
        recordingSid: RecordingSid,
        callSid: CallSid,
        duration: RecordingDuration,
        status: RecordingStatus,
        startTime: RecordingStartTime,
        endTime: RecordingEndTime
      });
    }
    
    res.status(204).end();
  } catch (err) { next(err); }
});

// 5) Transcription status callback endpoint
app.post("/api/voice/transcription-status", express.urlencoded({ extended: false }), (req, res, next) => {
  try {
    if (!isValidTwilioRequest(req)) return res.status(403).json({ error: "Invalid Twilio signature" });
    
    const { 
      TranscriptionSid,
      TranscriptionText,
      TranscriptionStatus,
      TranscriptionUrl,
      RecordingSid,
      CallSid,
      Confidence,
      AudioUrl
    } = req.body || {};
    
    console.log("[Transcription Status]", { 
      TranscriptionSid,
      TranscriptionStatus,
      RecordingSid,
      CallSid,
      Confidence
    });
    
    if (TranscriptionStatus === 'completed' && TranscriptionText) {
      // Process transcription for AI knowledge base
      const transcription = {
        sid: TranscriptionSid,
        text: TranscriptionText,
        status: TranscriptionStatus,
        url: TranscriptionUrl,
        recordingSid: RecordingSid,
        callSid: CallSid,
        confidence: Confidence,
        audioUrl: AudioUrl,
        createdAt: new Date().toISOString(),
        processed: false
      };
      
      // Store transcription (in production, use database)
      transcriptions.set(TranscriptionSid, transcription);
      
      // Process for AI knowledge base
      processTranscriptionForAI(transcription);
      
      // Update contact profile with transcription data
      const recording = recordings.get(RecordingSid);
      if (recording) {
        const phoneNumber = recording.callSid; // In a real app, extract actual phone number
        if (phoneNumber) {
          const contact = getOrCreateContact(phoneNumber);
          
          // Add topics to contact profile
          if (transcription.metadata?.topics) {
            transcription.metadata.topics.forEach(topic => contact.topics.add(topic));
          }
          
          // Add action items to contact profile
          if (transcription.metadata?.actionItems) {
            transcription.metadata.actionItems.forEach(item => {
              contact.actionItems.push({
                id: Date.now().toString(),
                text: item,
                createdAt: new Date().toISOString(),
                completed: false,
                source: 'transcription',
                transcriptionSid: TranscriptionSid
              });
            });
          }
          
          // Update sentiment tracking
          if (transcription.metadata?.sentiment) {
            contact.sentiment[transcription.metadata.sentiment]++;
          }
          
          console.log("[Contact Updated]", { phoneNumber, topics: Array.from(contact.topics), actionItems: contact.actionItems.length });
        }
      }
      
      console.log("[Transcription Saved]", transcription);
    }
    
    res.status(204).end();
  } catch (err) { next(err); }
});

// 6) Simple endpoint for webhook validation testing
app.post("/api/voice/validate", (req, res) => res.json({ ok: true }));

// 6) Recording, transcription, and conversation management
// In-memory storage for recordings, transcriptions, and contacts (use database in production)
const recordings = new Map();
const transcriptions = new Map();
const contacts = new Map(); // Phone number -> contact profile
const conversations = new Map(); // Phone number -> conversation history

// Transcription processing for AI knowledge base
function processTranscriptionForAI(transcription) {
  try {
    // Parse transcription text for speaker identification and structure
    const processed = {
      ...transcription,
      processed: true,
      processedAt: new Date().toISOString(),
      
      // Extract conversation metadata
      metadata: {
        wordCount: transcription.text.split(' ').length,
        duration: transcription.text.length / 10, // Rough estimate
        confidence: transcription.confidence,
        language: 'en', // Default, could be detected
        speakers: detectSpeakers(transcription.text),
        topics: extractTopics(transcription.text),
        actionItems: extractActionItems(transcription.text),
        sentiment: analyzeSentiment(transcription.text)
      },
      
      // Structured output for vector databases
      vectorReady: {
        chunks: createVectorChunks(transcription.text),
        embeddings: [], // Would be populated by embedding service
        summary: generateSummary(transcription.text),
        keyInsights: extractKeyInsights(transcription.text)
      },
      
      // Export formats
      exports: {
        json: createJSONExport(transcription),
        markdown: createMarkdownExport(transcription),
        jsonl: createJSONLExport(transcription),
        vector: createVectorExport(transcription)
      }
    };
    
    // Update transcription with processed data
    transcriptions.set(transcription.sid, processed);
    
    console.log("[AI Processing Complete]", {
      sid: transcription.sid,
      wordCount: processed.metadata.wordCount,
      topics: processed.metadata.topics,
      actionItems: processed.metadata.actionItems.length
    });
    
  } catch (error) {
    console.error("[AI Processing Error]", error);
  }
}

// Helper functions for conversation management
function normalizePhoneNumber(phone) {
  // Normalize phone number to consistent format
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  return `+${cleaned}`;
}

function getOrCreateContact(phoneNumber) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  
  if (!contacts.has(normalizedPhone)) {
    contacts.set(normalizedPhone, {
      phoneNumber: normalizedPhone,
      firstContact: new Date().toISOString(),
      lastContact: new Date().toISOString(),
      totalCalls: 0,
      totalDuration: 0,
      topics: new Set(),
      actionItems: [],
      sentiment: { positive: 0, negative: 0, neutral: 0 },
      relationship: 'new',
      notes: '',
      tags: []
    });
  }
  
  return contacts.get(normalizedPhone);
}

function updateContactProfile(phoneNumber, callData) {
  const contact = getOrCreateContact(phoneNumber);
  
  contact.lastContact = new Date().toISOString();
  contact.totalCalls += 1;
  contact.totalDuration += callData.duration || 0;
  
  // Update relationship status based on call frequency
  const daysSinceFirst = (new Date() - new Date(contact.firstContact)) / (1000 * 60 * 60 * 24);
  const callsPerMonth = contact.totalCalls / (daysSinceFirst / 30);
  
  if (callsPerMonth >= 4) contact.relationship = 'frequent';
  else if (callsPerMonth >= 2) contact.relationship = 'regular';
  else if (contact.totalCalls >= 3) contact.relationship = 'occasional';
  else contact.relationship = 'new';
  
  return contact;
}

function addConversationEntry(phoneNumber, conversationData) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  
  if (!conversations.has(normalizedPhone)) {
    conversations.set(normalizedPhone, []);
  }
  
  const conversationHistory = conversations.get(normalizedPhone);
  conversationHistory.push({
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    ...conversationData
  });
  
  // Keep only last 50 conversations per contact
  if (conversationHistory.length > 50) {
    conversationHistory.splice(0, conversationHistory.length - 50);
  }
  
  return conversationHistory;
}

// Helper functions for transcription processing
function detectSpeakers(text) {
  // Simple speaker detection (in production, use more sophisticated NLP)
  const speakerPatterns = [
    /speaker\s+\d+/gi,
    /participant\s+\d+/gi,
    /caller\s+\d+/gi
  ];
  
  const speakers = new Set();
  speakerPatterns.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      matches.forEach(match => speakers.add(match.toLowerCase()));
    }
  });
  
  return Array.from(speakers);
}

function extractTopics(text) {
  // Simple topic extraction (in production, use NLP libraries)
  const topics = [];
  const topicKeywords = [
    'meeting', 'project', 'deadline', 'budget', 'client', 'team',
    'development', 'design', 'marketing', 'sales', 'support',
    'technical', 'business', 'strategy', 'planning'
  ];
  
  topicKeywords.forEach(keyword => {
    if (text.toLowerCase().includes(keyword)) {
      topics.push(keyword);
    }
  });
  
  return topics;
}

function extractActionItems(text) {
  // Extract action items and decisions
  const actionItems = [];
  const actionPatterns = [
    /(?:need to|will|going to|should|must)\s+([^.!?]+)/gi,
    /(?:action item|todo|task):\s*([^.!?]+)/gi,
    /(?:decision|decided):\s*([^.!?]+)/gi
  ];
  
  actionPatterns.forEach(pattern => {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      actionItems.push(match[1]?.trim());
    }
  });
  
  return actionItems.filter(item => item && item.length > 5);
}

function analyzeSentiment(text) {
  // Simple sentiment analysis (in production, use NLP libraries)
  const positiveWords = ['good', 'great', 'excellent', 'positive', 'happy', 'success'];
  const negativeWords = ['bad', 'terrible', 'negative', 'unhappy', 'failure', 'problem'];
  
  const words = text.toLowerCase().split(' ');
  const positiveCount = words.filter(word => positiveWords.includes(word)).length;
  const negativeCount = words.filter(word => negativeWords.includes(word)).length;
  
  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'neutral';
}

function createVectorChunks(text, chunkSize = 200) {
  // Create chunks for vector embeddings
  const words = text.split(' ');
  const chunks = [];
  
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push({
      id: `chunk_${i}`,
      text: words.slice(i, i + chunkSize).join(' '),
      startWord: i,
      endWord: Math.min(i + chunkSize, words.length)
    });
  }
  
  return chunks;
}

function generateSummary(text) {
  // Simple summary generation (in production, use AI models)
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const summary = sentences.slice(0, 3).join('. ');
  return summary + (summary.endsWith('.') ? '' : '.');
}

function extractKeyInsights(text) {
  // Extract key insights and important points
  const insights = [];
  const insightPatterns = [
    /(?:important|key|critical|essential):\s*([^.!?]+)/gi,
    /(?:note that|remember that|keep in mind):\s*([^.!?]+)/gi
  ];
  
  insightPatterns.forEach(pattern => {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      insights.push(match[1]?.trim());
    }
  });
  
  return insights.filter(insight => insight && insight.length > 10);
}

function createJSONExport(transcription) {
  return {
    sid: transcription.sid,
    text: transcription.text,
    confidence: transcription.confidence,
    callSid: transcription.callSid,
    recordingSid: transcription.recordingSid,
    createdAt: transcription.createdAt,
    metadata: {
      wordCount: transcription.text.split(' ').length,
      confidence: transcription.confidence
    }
  };
}

function createMarkdownExport(transcription) {
  return `# Call Transcription

**Call SID:** ${transcription.callSid}
**Recording SID:** ${transcription.recordingSid}
**Date:** ${new Date(transcription.createdAt).toLocaleString()}
**Confidence:** ${transcription.confidence}

## Transcript

${transcription.text}

---
*Generated by Twilio Voice Dialer Transcription System*
`;
}

function createJSONLExport(transcription) {
  // JSONL format for fine-tuning datasets
  return {
    messages: [
      { role: "system", content: "This is a phone call transcription." },
      { role: "user", content: transcription.text }
    ],
    metadata: {
      sid: transcription.sid,
      callSid: transcription.callSid,
      confidence: transcription.confidence
    }
  };
}

function createVectorExport(transcription) {
  // Vector-ready format for RAG systems
  return {
    id: transcription.sid,
    content: transcription.text,
    metadata: {
      type: "call_transcription",
      callSid: transcription.callSid,
      recordingSid: transcription.recordingSid,
      confidence: transcription.confidence,
      createdAt: transcription.createdAt
    },
    embedding: null // Would be populated by embedding service
  };
}

// Conversation context building functions
function buildConversationContext(phoneNumber) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  const contact = contacts.get(normalizedPhone);
  const conversationHistory = conversations.get(normalizedPhone) || [];
  
  if (!contact) {
    return null;
  }
  
  // Aggregate all transcriptions for this contact
  const contactTranscriptions = Array.from(transcriptions.values())
    .filter(t => {
      // Find recording associated with this transcription
      const recording = recordings.get(t.recordingSid);
      return recording && normalizePhoneNumber(recording.callSid) === normalizedPhone;
    })
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  
  // Build chronological conversation history
  const fullHistory = contactTranscriptions.map(t => ({
    date: t.createdAt,
    text: t.text,
    confidence: t.confidence,
    topics: t.metadata?.topics || [],
    actionItems: t.metadata?.actionItems || [],
    sentiment: t.metadata?.sentiment || 'neutral',
    summary: t.vectorReady?.summary || ''
  }));
  
  // Extract recurring patterns
  const allTopics = new Set();
  const allActionItems = [];
  const sentimentTrend = [];
  
  fullHistory.forEach(entry => {
    entry.topics.forEach(topic => allTopics.add(topic));
    allActionItems.push(...entry.actionItems);
    sentimentTrend.push(entry.sentiment);
  });
  
  // Generate contact summary
  const summary = generateContactSummary(contact, fullHistory);
  
  return {
    contact: {
      ...contact,
      topics: Array.from(allTopics),
      actionItems: allActionItems,
      sentimentTrend
    },
    conversationHistory: fullHistory,
    summary,
    relationshipInsights: analyzeRelationshipPatterns(contact, fullHistory),
    communicationPatterns: analyzeCommunicationPatterns(contact, fullHistory)
  };
}

function generateContactSummary(contact, conversationHistory) {
  const totalWords = conversationHistory.reduce((sum, entry) => sum + (entry.text?.split(' ').length || 0), 0);
  const avgWordsPerCall = totalWords / contact.totalCalls;
  const avgDuration = contact.totalDuration / contact.totalCalls;
  
  const recentTopics = conversationHistory
    .slice(-5) // Last 5 conversations
    .flatMap(entry => entry.topics)
    .filter((topic, index, arr) => arr.indexOf(topic) === index); // Unique topics
  
  const pendingActionItems = contact.actionItems.filter(item => 
    !item.completed && new Date(item.createdAt) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
  );
  
  return {
    relationship: contact.relationship,
    totalCalls: contact.totalCalls,
    totalDuration: contact.totalDuration,
    avgWordsPerCall: Math.round(avgWordsPerCall),
    avgDuration: Math.round(avgDuration),
    recentTopics,
    pendingActionItems: pendingActionItems.length,
    lastContact: contact.lastContact,
    communicationFrequency: calculateCommunicationFrequency(contact)
  };
}

function analyzeRelationshipPatterns(contact, conversationHistory) {
  const patterns = {
    callFrequency: calculateCommunicationFrequency(contact),
    topicConsistency: analyzeTopicConsistency(conversationHistory),
    sentimentTrend: analyzeSentimentTrend(conversationHistory),
    actionItemCompletion: analyzeActionItemCompletion(contact),
    communicationStyle: analyzeCommunicationStyle(conversationHistory)
  };
  
  return patterns;
}

function analyzeCommunicationPatterns(contact, conversationHistory) {
  const patterns = {
    preferredTopics: getPreferredTopics(conversationHistory),
    communicationTiming: analyzeCallTiming(conversationHistory),
    conversationLength: analyzeConversationLength(conversationHistory),
    followUpPatterns: analyzeFollowUpPatterns(conversationHistory),
    decisionMakingStyle: analyzeDecisionMakingStyle(conversationHistory)
  };
  
  return patterns;
}

function calculateCommunicationFrequency(contact) {
  const daysSinceFirst = (new Date() - new Date(contact.firstContact)) / (1000 * 60 * 60 * 24);
  const callsPerMonth = contact.totalCalls / (daysSinceFirst / 30);
  
  if (callsPerMonth >= 4) return 'very frequent';
  if (callsPerMonth >= 2) return 'frequent';
  if (callsPerMonth >= 1) return 'regular';
  if (callsPerMonth >= 0.5) return 'occasional';
  return 'rare';
}

function analyzeTopicConsistency(conversationHistory) {
  const allTopics = conversationHistory.flatMap(entry => entry.topics);
  const topicFrequency = {};
  
  allTopics.forEach(topic => {
    topicFrequency[topic] = (topicFrequency[topic] || 0) + 1;
  });
  
  const recurringTopics = Object.entries(topicFrequency)
    .filter(([topic, count]) => count > 1)
    .sort(([,a], [,b]) => b - a)
    .map(([topic]) => topic);
  
  return {
    recurringTopics,
    topicDiversity: Object.keys(topicFrequency).length,
    mostFrequentTopic: recurringTopics[0] || null
  };
}

function analyzeSentimentTrend(conversationHistory) {
  const sentiments = conversationHistory.map(entry => entry.sentiment);
  const recentSentiments = sentiments.slice(-3); // Last 3 conversations
  
  const positiveCount = sentiments.filter(s => s === 'positive').length;
  const negativeCount = sentiments.filter(s => s === 'negative').length;
  const neutralCount = sentiments.filter(s => s === 'neutral').length;
  
  const overallSentiment = positiveCount > negativeCount ? 'positive' : 
                          negativeCount > positiveCount ? 'negative' : 'neutral';
  
  const trend = recentSentiments.length >= 2 ? 
    (recentSentiments[recentSentiments.length - 1] === recentSentiments[0] ? 'stable' : 'changing') : 'insufficient';
  
  return {
    overall: overallSentiment,
    trend,
    positivePercentage: Math.round((positiveCount / sentiments.length) * 100),
    negativePercentage: Math.round((negativeCount / sentiments.length) * 100),
    neutralPercentage: Math.round((neutralCount / sentiments.length) * 100)
  };
}

function getPreferredTopics(conversationHistory) {
  const topicFrequency = {};
  
  conversationHistory.forEach(entry => {
    entry.topics.forEach(topic => {
      topicFrequency[topic] = (topicFrequency[topic] || 0) + 1;
    });
  });
  
  return Object.entries(topicFrequency)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([topic, count]) => ({ topic, frequency: count }));
}

function analyzeCallTiming(conversationHistory) {
  const callTimes = conversationHistory.map(entry => new Date(entry.date).getHours());
  const timeSlots = {
    morning: callTimes.filter(hour => hour >= 6 && hour < 12).length,
    afternoon: callTimes.filter(hour => hour >= 12 && hour < 17).length,
    evening: callTimes.filter(hour => hour >= 17 && hour < 21).length,
    night: callTimes.filter(hour => hour >= 21 || hour < 6).length
  };
  
  const preferredTime = Object.entries(timeSlots)
    .sort(([,a], [,b]) => b - a)[0][0];
  
  return {
    preferredTime,
    timeDistribution: timeSlots,
    consistency: Math.max(...Object.values(timeSlots)) / conversationHistory.length
  };
}

function analyzeConversationLength(conversationHistory) {
  const lengths = conversationHistory.map(entry => entry.text?.split(' ').length || 0);
  const avgLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  
  return {
    averageLength: Math.round(avgLength),
    shortestCall: Math.min(...lengths),
    longestCall: Math.max(...lengths),
    lengthVariability: Math.round((Math.max(...lengths) - Math.min(...lengths)) / avgLength * 100)
  };
}

function analyzeFollowUpPatterns(conversationHistory) {
  const followUpPatterns = [];
  
  for (let i = 1; i < conversationHistory.length; i++) {
    const current = conversationHistory[i];
    const previous = conversationHistory[i - 1];
    
    const daysBetween = (new Date(current.date) - new Date(previous.date)) / (1000 * 60 * 60 * 24);
    
    if (daysBetween <= 7) {
      followUpPatterns.push({
        type: 'quick_followup',
        daysBetween,
        previousTopics: previous.topics,
        currentTopics: current.topics
      });
    }
  }
  
  return {
    quickFollowUps: followUpPatterns.length,
    averageFollowUpTime: followUpPatterns.length > 0 ? 
      Math.round(followUpPatterns.reduce((sum, pattern) => sum + pattern.daysBetween, 0) / followUpPatterns.length) : null,
    followUpTopics: followUpPatterns.map(pattern => pattern.currentTopics).flat()
  };
}

function analyzeDecisionMakingStyle(conversationHistory) {
  const decisionKeywords = ['decide', 'decision', 'choose', 'option', 'prefer', 'recommend'];
  const decisionCounts = conversationHistory.map(entry => {
    const text = entry.text.toLowerCase();
    return decisionKeywords.filter(keyword => text.includes(keyword)).length;
  });
  
  const totalDecisions = decisionCounts.reduce((sum, count) => sum + count, 0);
  const avgDecisionsPerCall = totalDecisions / conversationHistory.length;
  
  return {
    totalDecisions,
    averageDecisionsPerCall: Math.round(avgDecisionsPerCall * 10) / 10,
    decisionFrequency: avgDecisionsPerCall > 2 ? 'high' : avgDecisionsPerCall > 1 ? 'medium' : 'low',
    decisionTopics: conversationHistory
      .filter(entry => decisionKeywords.some(keyword => entry.text.toLowerCase().includes(keyword)))
      .flatMap(entry => entry.topics)
  };
}

function analyzeActionItemCompletion(contact) {
  const completedItems = contact.actionItems.filter(item => item.completed).length;
  const totalItems = contact.actionItems.length;
  
  return {
    totalActionItems: totalItems,
    completedItems: completedItems,
    completionRate: totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0,
    averageCompletionTime: calculateAverageCompletionTime(contact.actionItems),
    pendingItems: totalItems - completedItems
  };
}

function calculateAverageCompletionTime(actionItems) {
  const completedItems = actionItems.filter(item => item.completed && item.completedAt);
  
  if (completedItems.length === 0) return null;
  
  const totalTime = completedItems.reduce((sum, item) => {
    const created = new Date(item.createdAt);
    const completed = new Date(item.completedAt);
    return sum + (completed - created);
  }, 0);
  
  return Math.round(totalTime / completedItems.length / (1000 * 60 * 60 * 24)); // Days
}

function analyzeCommunicationStyle(conversationHistory) {
  if (conversationHistory.length === 0) {
    return {
      formality: 'unknown',
      engagement: 'unknown',
      responsiveness: 'unknown',
      communicationPreference: 'unknown'
    };
  }
  
  // Analyze formality based on language patterns
  const formalWords = ['sir', 'madam', 'please', 'thank you', 'appreciate', 'regards'];
  const informalWords = ['hey', 'cool', 'awesome', 'thanks', 'bye', 'see ya'];
  
  const allText = conversationHistory.map(entry => entry.text.toLowerCase()).join(' ');
  const formalCount = formalWords.filter(word => allText.includes(word)).length;
  const informalCount = informalWords.filter(word => allText.includes(word)).length;
  
  const formality = formalCount > informalCount ? 'formal' : 
                   informalCount > formalCount ? 'informal' : 'mixed';
  
  // Analyze engagement based on conversation length and topics
  const avgLength = conversationHistory.reduce((sum, entry) => sum + (entry.text?.split(' ').length || 0), 0) / conversationHistory.length;
  const engagement = avgLength > 200 ? 'high' : avgLength > 100 ? 'medium' : 'low';
  
  // Analyze responsiveness based on follow-up patterns
  const followUpPatterns = analyzeFollowUpPatterns(conversationHistory);
  const responsiveness = followUpPatterns.quickFollowUps > 2 ? 'high' : 
                        followUpPatterns.quickFollowUps > 0 ? 'medium' : 'low';
  
  // Determine communication preference
  const communicationPreference = engagement === 'high' && responsiveness === 'high' ? 'very_engaged' :
                                 engagement === 'high' ? 'engaged' :
                                 responsiveness === 'high' ? 'responsive' : 'standard';
  
  return {
    formality,
    engagement,
    responsiveness,
    communicationPreference
  };
}

function generatePreCallBriefing(context) {
  const { contact, conversationHistory, summary, relationshipInsights, communicationPatterns } = context;
  
  // Calculate days since last contact
  const daysSinceLastContact = Math.round((new Date() - new Date(contact.lastContact)) / (1000 * 60 * 60 * 24));
  
  // Get recent conversations
  const recentConversations = conversationHistory.slice(-3);
  const lastConversation = recentConversations[recentConversations.length - 1];
  
  // Get pending action items
  const pendingActionItems = contact.actionItems.filter(item => !item.completed);
  
  // Get recurring topics
  const recurringTopics = relationshipInsights.topicConsistency.recurringTopics;
  
  // Generate briefing sections
  const briefing = {
    relationship: {
      status: contact.relationship,
      totalCalls: contact.totalCalls,
      daysSinceLastContact,
      communicationFrequency: summary.communicationFrequency
    },
    
    lastInteraction: lastConversation ? {
      date: lastConversation.date,
      topics: lastConversation.topics,
      actionItems: lastConversation.actionItems,
      sentiment: lastConversation.sentiment
    } : null,
    
    followUpItems: pendingActionItems.length > 0 ? {
      count: pendingActionItems.length,
      items: pendingActionItems.slice(-5).map(item => ({
        text: item.text,
        createdAt: item.createdAt,
        daysOld: Math.round((new Date() - new Date(item.createdAt)) / (1000 * 60 * 60 * 24))
      }))
    } : null,
    
    conversationGuidance: {
      preferredTopics: communicationPatterns.preferredTopics.slice(0, 3),
      communicationStyle: relationshipInsights.communicationStyle,
      formality: relationshipInsights.communicationStyle.formality,
      engagement: relationshipInsights.communicationStyle.engagement
    },
    
    contextReminders: {
      recurringTopics: recurringTopics.slice(0, 3),
      recentTopics: contact.topics.slice(-5),
      sentimentTrend: relationshipInsights.sentimentTrend.overall,
      decisionMakingStyle: communicationPatterns.decisionMakingStyle.decisionFrequency
    },
    
    aiSuggestions: generateAISuggestions(context)
  };
  
  return briefing;
}

function generateAISuggestions(context) {
  const { contact, conversationHistory, relationshipInsights, communicationPatterns } = context;
  
  const suggestions = [];
  
  // Suggest follow-up on pending items
  const pendingItems = contact.actionItems.filter(item => !item.completed);
  if (pendingItems.length > 0) {
    suggestions.push({
      type: 'follow_up',
      priority: 'high',
      message: `Follow up on ${pendingItems.length} pending action item(s) from previous conversations`
    });
  }
  
  // Suggest based on communication frequency
  const daysSinceLastContact = Math.round((new Date() - new Date(contact.lastContact)) / (1000 * 60 * 60 * 24));
  if (daysSinceLastContact > 30 && contact.relationship === 'frequent') {
    suggestions.push({
      type: 'reconnect',
      priority: 'medium',
      message: 'Reconnect after extended period - consider relationship maintenance'
    });
  }
  
  // Suggest based on sentiment trend
  if (relationshipInsights.sentimentTrend.trend === 'changing' && relationshipInsights.sentimentTrend.overall === 'negative') {
    suggestions.push({
      type: 'sentiment_improvement',
      priority: 'high',
      message: 'Focus on improving conversation sentiment - recent trend has been negative'
    });
  }
  
  // Suggest based on communication style
  if (relationshipInsights.communicationStyle.engagement === 'low') {
    suggestions.push({
      type: 'engagement',
      priority: 'medium',
      message: 'Focus on increasing engagement - this contact tends to have shorter conversations'
    });
  }
  
  // Suggest based on preferred topics
  const preferredTopics = communicationPatterns.preferredTopics;
  if (preferredTopics.length > 0) {
    suggestions.push({
      type: 'topic_focus',
      priority: 'medium',
      message: `Focus on preferred topics: ${preferredTopics.slice(0, 2).map(t => t.topic).join(', ')}`
    });
  }
  
  return suggestions;
}

// List all recordings
app.get("/api/recordings", (req, res) => {
  try {
    const recordingsList = Array.from(recordings.values()).sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json({ recordings: recordingsList });
  } catch (err) { next(err); }
});

// Get recording details by SID
app.get("/api/recordings/:sid", (req, res) => {
  try {
    const { sid } = req.params;
    const recording = recordings.get(sid);
    
    if (!recording) {
      return res.status(404).json({ error: "Recording not found" });
    }
    
    res.json({ recording });
  } catch (err) { next(err); }
});

// Download recording (proxy to Twilio)
app.get("/api/recordings/:sid/download", async (req, res) => {
  try {
    const { sid } = req.params;
    const recording = recordings.get(sid);
    
    if (!recording) {
      return res.status(404).json({ error: "Recording not found" });
    }
    
    // Redirect to Twilio's recording URL
    res.redirect(recording.url);
  } catch (err) { next(err); }
});

// 7) Transcription management endpoints
// List all transcriptions
app.get("/api/transcriptions", (req, res) => {
  try {
    const transcriptionsList = Array.from(transcriptions.values()).sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json({ transcriptions: transcriptionsList });
  } catch (err) { next(err); }
});

// Get transcription details by SID
app.get("/api/transcriptions/:sid", (req, res) => {
  try {
    const { sid } = req.params;
    const transcription = transcriptions.get(sid);
    
    if (!transcription) {
      return res.status(404).json({ error: "Transcription not found" });
    }
    
    res.json({ transcription });
  } catch (err) { next(err); }
});

// Export transcription in different formats
app.get("/api/transcriptions/:sid/export", (req, res) => {
  try {
    const { sid } = req.params;
    const { format = 'json' } = req.query;
    const transcription = transcriptions.get(sid);
    
    if (!transcription) {
      return res.status(404).json({ error: "Transcription not found" });
    }
    
    let exportData;
    let contentType;
    let filename;
    
    switch (format.toLowerCase()) {
      case 'json':
        exportData = transcription.exports.json;
        contentType = 'application/json';
        filename = `transcription_${sid}.json`;
        break;
      case 'markdown':
        exportData = transcription.exports.markdown;
        contentType = 'text/markdown';
        filename = `transcription_${sid}.md`;
        break;
      case 'jsonl':
        exportData = JSON.stringify(transcription.exports.jsonl);
        contentType = 'application/jsonl';
        filename = `transcription_${sid}.jsonl`;
        break;
      case 'vector':
        exportData = transcription.exports.vector;
        contentType = 'application/json';
        filename = `transcription_${sid}_vector.json`;
        break;
      default:
        return res.status(400).json({ error: "Invalid format. Use: json, markdown, jsonl, or vector" });
    }
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(exportData);
  } catch (err) { next(err); }
});

// Search transcriptions
app.get("/api/transcriptions/search", (req, res) => {
  try {
    const { q: query, topic, sentiment, limit = 10 } = req.query;
    
    let results = Array.from(transcriptions.values());
    
    // Filter by search query
    if (query) {
      results = results.filter(t => 
        t.text.toLowerCase().includes(query.toLowerCase()) ||
        t.metadata?.topics?.some(topic => topic.toLowerCase().includes(query.toLowerCase()))
      );
    }
    
    // Filter by topic
    if (topic) {
      results = results.filter(t => 
        t.metadata?.topics?.includes(topic)
      );
    }
    
    // Filter by sentiment
    if (sentiment) {
      results = results.filter(t => 
        t.metadata?.sentiment === sentiment
      );
    }
    
    // Sort by relevance/date and limit
    results = results
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, parseInt(limit));
    
    res.json({ 
      transcriptions: results,
      total: results.length,
      query: { query, topic, sentiment, limit }
    });
  } catch (err) { next(err); }
});

// 8) Conversation management endpoints
// Get full conversation history for a contact
app.get("/api/contacts/:phoneNumber/conversations", (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    
    const context = buildConversationContext(normalizedPhone);
    if (!context) {
      return res.status(404).json({ error: "Contact not found" });
    }
    
    res.json({
      contact: context.contact,
      conversations: context.conversationHistory,
      total: context.conversationHistory.length
    });
  } catch (err) { next(err); }
});

// Get AI summary context for a contact
app.get("/api/contacts/:phoneNumber/context", (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    
    const context = buildConversationContext(normalizedPhone);
    if (!context) {
      return res.status(404).json({ error: "Contact not found" });
    }
    
    res.json({
      summary: context.summary,
      relationshipInsights: context.relationshipInsights,
      communicationPatterns: context.communicationPatterns,
      recentTopics: context.contact.topics.slice(-10), // Last 10 topics
      pendingActionItems: context.contact.actionItems.filter(item => !item.completed)
    });
  } catch (err) { next(err); }
});

// Get insights and patterns for a contact
app.get("/api/contacts/:phoneNumber/insights", (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    
    const context = buildConversationContext(normalizedPhone);
    if (!context) {
      return res.status(404).json({ error: "Contact not found" });
    }
    
    res.json({
      insights: {
        relationship: context.relationshipInsights,
        communication: context.communicationPatterns,
        topics: context.contact.topics,
        sentiment: context.contact.sentiment,
        actionItems: context.contact.actionItems
      },
      patterns: {
        callFrequency: context.summary.communicationFrequency,
        preferredTopics: context.communicationPatterns.preferredTopics,
        communicationStyle: context.relationshipInsights.communicationStyle,
        followUpPatterns: context.communicationPatterns.followUpPatterns
      }
    });
  } catch (err) { next(err); }
});

// Generate pre-call briefing for a contact
app.post("/api/contacts/:phoneNumber/prepare", (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    
    const context = buildConversationContext(normalizedPhone);
    if (!context) {
      return res.status(404).json({ error: "Contact not found" });
    }
    
    // Generate pre-call briefing
    const briefing = generatePreCallBriefing(context);
    
    res.json({
      briefing,
      context: {
        lastContact: context.contact.lastContact,
        totalCalls: context.contact.totalCalls,
        relationship: context.contact.relationship,
        recentTopics: context.contact.topics.slice(-5),
        pendingActionItems: context.contact.actionItems.filter(item => !item.completed)
      }
    });
  } catch (err) { next(err); }
});

// List all contacts with conversation data
app.get("/api/contacts", (req, res) => {
  try {
    const contactsList = Array.from(contacts.values()).map(contact => {
      const context = buildConversationContext(contact.phoneNumber);
      return {
        phoneNumber: contact.phoneNumber,
        firstContact: contact.firstContact,
        lastContact: contact.lastContact,
        totalCalls: contact.totalCalls,
        relationship: contact.relationship,
        recentTopics: context?.contact.topics.slice(-3) || [],
        pendingActionItems: context?.contact.actionItems.filter(item => !item.completed).length || 0,
        summary: context?.summary || null
      };
    }).sort((a, b) => new Date(b.lastContact) - new Date(a.lastContact));
    
    res.json({ contacts: contactsList });
  } catch (err) { next(err); }
});

// 9) 404 and error handlers
app.use((req, res) => res.status(404).json({ error: "Not Found" }));
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
});

// Memory management for production
if (process.env.NODE_ENV === 'production') {
  // Clean up old data every 24 hours
  setInterval(() => {
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    // Clean old recordings
    for (const [key, value] of recordings.entries()) {
      if (new Date(value.createdAt).getTime() < oneWeekAgo) {
        recordings.delete(key);
      }
    }
    
    // Clean old transcriptions
    for (const [key, value] of transcriptions.entries()) {
      if (new Date(value.createdAt).getTime() < oneWeekAgo) {
        transcriptions.delete(key);
      }
    }
    
    console.log('Memory cleanup completed');
  }, 24 * 60 * 60 * 1000); // Daily cleanup
}

const PORT = parseInt(process.env.PORT || "5001", 10);
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
