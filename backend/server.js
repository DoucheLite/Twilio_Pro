const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const Twilio = require("twilio");

// Load env from project root .env
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
app.set("trust proxy", 1);

// Security
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));

// Body parsing (Twilio webhooks use urlencoded)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS (frontend during local dev)
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:5173").split(",");
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// Logging
const logFormat = process.env.NODE_ENV === "production" ? "combined" : "dev";
app.use(morgan(logFormat));

// Rate limiting for API
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use("/api/", limiter);

// Validate required configuration
const requiredEnv = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_TWIML_APP_SID",
  "CALLER_ID",
];
function ensureEnv() {
  const missing = requiredEnv.filter((k) => !process.env[k]);
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

  // 1) Access token generation for Twilio Voice SDK
  app.post("/api/token", (req, res, next) => {
    try {
      const envErr = ensureEnv();
      if (envErr) return res.status(500).json({ error: envErr });

      const AccessToken = Twilio.jwt.AccessToken;
      const VoiceGrant = AccessToken.VoiceGrant;

      // choose identity from query param or random
      let identity = (req.query.identity || "").trim() || `user_${Math.random().toString(36).slice(2, 10)}`;

      const token = new AccessToken(
        process.env.TWILIO_ACCOUNT_SID,       // <-- keep this
        process.env.TWILIO_API_KEY_SID,
        process.env.TWILIO_API_KEY_SECRET,
        {
          identity, // REQUIRED
          ttl: parseInt(process.env.TOKEN_TTL_SECONDS || "3600", 10),
        }
      );

      // add a Voice grant if you're doing calls
      const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
        incomingAllow: true,
      });
      token.addGrant(voiceGrant);

      res.json({ token: token.toJwt(), identity, expires_in: token.ttl });
    } catch (err) { next(err); }
  });

// 2) TwiML responses for outgoing calls
app.post("/api/voice/outgoing", (req, res, next) => {
  try {
    const envErr = ensureEnv();
    if (envErr) return res.status(500).type("text/xml").send(`<Response><Say>${envErr}</Say></Response>`);

    const twiml = new Twilio.twiml.VoiceResponse();
    const callerId = process.env.CALLER_ID;
    const to = req.body.To || req.body.to || req.body.phoneNumber || "";

    if (!to) {
      const dial = twiml.dial({ callerId });
      dial.client("client");
    } else if (/^[\d+*#]+$/.test(to)) {
      twiml.dial({ callerId }, to);
    } else {
      const dial = twiml.dial({ callerId });
      dial.client(to);
    }

    res.type("text/xml").send(twiml.toString());
  } catch (err) { next(err); }
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

// 4) Simple endpoint for webhook validation testing
app.post("/api/voice/validate", (req, res) => res.json({ ok: true }));

// 5) 404 and error handlers
app.use((req, res) => res.status(404).json({ error: "Not Found" }));
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
});

const PORT = parseInt(process.env.PORT || "5001", 10);
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
