# Dual-Channel Call Recording Setup Guide

## Overview

The Twilio Voice Dialer now supports dual-channel call recording with separate audio tracks for each participant. This provides better audio quality and enables advanced analysis of individual speaker audio.

## Features Implemented

### ✅ Backend Recording Configuration
- **TwiML Recording**: Automatic recording starts when call is answered
- **Dual Channels**: Separate audio tracks for caller and callee
- **Recording Status Callbacks**: Webhook notifications when recordings complete
- **Recording Management**: List, view, and download recordings

### ✅ Frontend Recording Interface
- **Recording Indicator**: Shows "Recording" status during active calls
- **Recordings List**: Collapsible interface to view all recordings
- **Download Functionality**: Direct download links to recording files
- **Metadata Display**: Duration, channels, and timestamp information

## Backend Endpoints

### Recording Configuration
- **POST** `/api/voice/outgoing` - TwiML response with recording enabled
- **POST** `/api/voice/recording-status` - Webhook for recording completion events

### Recording Management
- **GET** `/api/recordings` - List all recordings
- **GET** `/api/recordings/:sid` - Get recording details by SID
- **GET** `/api/recordings/:sid/download` - Download recording file

## TwiML Recording Configuration

The backend automatically configures recordings with these settings:

```xml
<Dial 
  record="record-from-answer"
  recordingChannels="dual"
  recordingStatusCallback="http://localhost:5001/api/voice/recording-status"
  recordingStatusCallbackMethod="POST"
  recordingStatusCallbackEvent="completed"
>
  <!-- Phone number or client -->
</Dial>
```

### Recording Parameters
- **`record="record-from-answer"`**: Start recording when call is answered
- **`recordingChannels="dual"`**: Separate audio tracks for each participant
- **`recordingStatusCallback`**: Webhook URL for recording events
- **`recordingStatusCallbackMethod="POST"`**: HTTP method for callbacks
- **`recordingStatusCallbackEvent="completed"`**: Trigger on recording completion

## Environment Variables Required

Add these to your `.env` file:

```bash
# Required for recording functionality
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_API_KEY_SID=your_api_key_sid
TWILIO_API_KEY_SECRET=your_api_key_secret
TWILIO_TWIML_APP_SID=your_twiml_app_sid
CALLER_ID=your_twilio_phone_number

# Optional: For webhook signature validation
TWILIO_AUTH_TOKEN=your_auth_token
PUBLIC_BASE_URL=https://yourdomain.com  # or ngrok URL for local testing
```

## TwiML App Configuration

1. **Create TwiML App** in Twilio Console:
   - Go to Twilio Console → Voice → TwiML Apps
   - Create new TwiML App
   - Set Voice Request URL to: `http://localhost:5001/api/voice/outgoing`
   - Set HTTP Method to: `POST`

2. **For Local Development** (using ngrok):
   ```bash
   # Install ngrok
   npm install -g ngrok
   
   # Expose backend
   ngrok http 5001
   
   # Update TwiML App Voice URL to ngrok URL
   # Example: https://abc123.ngrok.io/api/voice/outgoing
   ```

## Recording Data Structure

Each recording includes:

```javascript
{
  sid: "RE1234567890abcdef",           // Twilio Recording SID
  url: "https://api.twilio.com/...",   // Direct download URL
  duration: 120,                       // Duration in seconds
  channels: "dual",                    // Recording channels
  callSid: "CA1234567890abcdef",       // Associated Call SID
  status: "completed",                 // Recording status
  startTime: "2023-01-01T12:00:00Z",   // Recording start time
  endTime: "2023-01-01T12:02:00Z",     // Recording end time
  createdAt: "2023-01-01T12:02:00Z"    // When recorded in our system
}
```

## Frontend Features

### Recording Status Indicator
- Shows "Recording" pill during active calls
- Automatically appears when call connects
- Disappears when call ends

### Recordings Interface
- **Toggle Button**: Show/hide recordings list
- **Recording List**: All recordings with metadata
- **Download Button**: Direct download to browser
- **Channel Info**: Shows "dual channels" for each recording

### Call History Integration
- Recordings are automatically fetched after calls end
- Recording metadata is displayed in the interface

## Testing the Recording System

### 1. Start Both Servers
```bash
# Terminal 1: Backend
cd backend
npm start

# Terminal 2: Frontend
cd frontend
npm start
```

### 2. Make a Test Call
1. Visit `http://localhost:3000`
2. Wait for device to show "ready" status
3. Enter a valid phone number
4. Click "Call" button
5. When call connects, you should see "Recording" indicator

### 3. Check Recording Results
1. End the call
2. Click "Show" in the Recordings section
3. You should see the recording with:
   - Call SID (last 8 characters)
   - Duration in MM:SS format
   - Timestamp
   - Download button
   - "dual channels" indicator

### 4. Verify Backend Logs
Check backend console for:
- TwiML request/response logs
- Recording status callback logs
- Recording metadata storage logs

## Troubleshooting

### Recording Not Starting
- Verify TwiML App Voice URL is correct
- Check that `PUBLIC_BASE_URL` is accessible from Twilio
- Ensure webhook endpoint `/api/voice/recording-status` is reachable

### Recording Status Callbacks Not Received
- Verify TwiML App configuration
- Check webhook URL is publicly accessible (use ngrok for local testing)
- Ensure `TWILIO_AUTH_TOKEN` is set for signature validation

### Frontend Not Showing Recordings
- Check browser console for API errors
- Verify backend `/api/recordings` endpoint returns data
- Ensure recordings are being stored in backend memory

### Download Links Not Working
- Verify Twilio recording URLs are accessible
- Check that recording SIDs are valid
- Ensure proper authentication for Twilio API access

## Production Considerations

### Database Storage
Replace in-memory storage with database:
```javascript
// Instead of Map, use database
const recording = await db.recordings.create({
  sid: RecordingSid,
  url: RecordingUrl,
  // ... other fields
});
```

### Security
- Implement proper authentication for recording access
- Add rate limiting to recording endpoints
- Validate Twilio webhook signatures

### Scalability
- Use cloud storage for recording files
- Implement recording cleanup policies
- Add pagination to recordings list

## API Reference

### GET /api/recordings
Returns list of all recordings.

**Response:**
```json
{
  "recordings": [
    {
      "sid": "RE1234567890abcdef",
      "url": "https://api.twilio.com/...",
      "duration": 120,
      "channels": "dual",
      "callSid": "CA1234567890abcdef",
      "status": "completed",
      "startTime": "2023-01-01T12:00:00Z",
      "endTime": "2023-01-01T12:02:00Z",
      "createdAt": "2023-01-01T12:02:00Z"
    }
  ]
}
```

### GET /api/recordings/:sid
Returns specific recording details.

### GET /api/recordings/:sid/download
Redirects to Twilio recording download URL.

### POST /api/voice/recording-status
Webhook endpoint for Twilio recording status callbacks. 