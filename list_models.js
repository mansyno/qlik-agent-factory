const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.error("Error: GEMINI_API_KEY is not set.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

async function listModels() {
    try {
        console.log("Listing available models...");
        // Usually handled via model-specific endpoints or documentation, 
        // but let's try a simple generation to see if we get a clearer error with suggestions
        // OR standard discovery if the SDK supports it. 
        // The error message suggests: "Call ListModels to see the list of available models"
        // The SDK doesn't expose ListModels directly on the top class in all versions, 
        // but simpler is to try a standard model like 'gemini-pro' and see if it works, 
        // OR use the REST API via fetch if the SDK is limiting.

        // Let's rely on the SDK's error message usually providing a list, 
        // or just try 'gemini-1.5-flash' which is likely 'older' but might still exist,
        // or 'gemini-pro' which often aliases to the latest.

        // However, since the user asks to "find the most recent", 
        // I will try to use the `listModels` method if it exists on the generic manager 
        // or just fetch it via REST.

        // Note: The Node.js SDK for Gemini (GoogleGenerativeAI) doesn't always have a direct listModels helper 
        // exposed in the main import in earlier versions. 
        // I'll try a direct fetch to the API endpoint which is universal.

        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.models) {
            console.log("Available Models:");
            data.models.forEach(m => {
                if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")) {
                    console.log(`- ${m.name} (${m.displayName})`);
                }
            });
        } else {
            console.log("Could not list models via REST:", data);
        }

    } catch (error) {
        console.error("Error listing models:", error);
    }
}

listModels();
