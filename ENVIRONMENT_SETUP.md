# Environment Setup Guide

## Required Environment Variables

Create a `.env` file in the `backend/` directory with the following variables:

```bash
# Server
PORT=5001
NODE_ENV=development
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
PUBLIC_BASE_URL=

# Twilio credentials (replace with your actual values)
TWILIO_ACCOUNT_SID=your_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_API_KEY_SID=your_api_key_sid_here
TWILIO_API_KEY_SECRET=your_api_key_secret_here
TWILIO_TWIML_APP_SID=your_twiml_app_sid_here
CALLER_ID=your_phone_number_here

# Tokens
TOKEN_TTL_SECONDS=3600
```

## Security Notes

- **Never commit your `.env` file** to version control
- **Keep your Twilio credentials secure** - they provide access to your Twilio account
- **Use different credentials** for development and production environments
- **Rotate your API keys** regularly for security

## Getting Twilio Credentials

1. Sign up for a Twilio account at https://www.twilio.com
2. Get your Account SID and Auth Token from the Twilio Console
3. Create an API Key and Secret in the Twilio Console
4. Create a TwiML App for voice functionality
5. Get a phone number for making calls 