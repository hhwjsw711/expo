/**
 * Mock Convex API
 * 
 * This is a temporary mock until you set up Convex and generate real types.
 * Replace this file with the generated API from your Convex backend.
 * 
 * To generate real types:
 * 1. Install Convex: npm install convex
 * 2. Link to your backend: npx convex dev
 * 3. This will generate convex/_generated/api.ts
 */

export const api = {
  phoneAuth: {
    sendOTP: { _name: "phoneAuth:sendOTP" as any },
  },
  users: {
    verifyOTP: { _name: "users:verifyOTP" as any },
    getCurrentUser: { _name: "users:getCurrentUser" as any },
    generateUploadUrl: { _name: "users:generateUploadUrl" as any },
    completeOnboarding: { _name: "users:completeOnboarding" as any },
    updateProfile: { _name: "users:updateProfile" as any },
    getDefaultVoices: { _name: "users:getDefaultVoices" as any },
    getVoicePreviewUrl: { _name: "users:getVoicePreviewUrl" as any },
    updateSelectedVoice: { _name: "users:updateSelectedVoice" as any },
  },
  tasks: {
    generateUploadUrl: { _name: "tasks:generateUploadUrl" as any },
    createProject: { _name: "tasks:createProject" as any },
    getProject: { _name: "tasks:getProject" as any },
    getProjects: { _name: "tasks:getProjects" as any },
    generateScriptOnly: { _name: "tasks:generateScriptOnly" as any },
    updateProjectScript: { _name: "tasks:updateProjectScript" as any },
    regenerateScript: { _name: "tasks:regenerateScript" as any },
    markProjectSubmitted: { _name: "tasks:markProjectSubmitted" as any },
    generateMediaAssets: { _name: "tasks:generateMediaAssets" as any },
    deleteProject: { _name: "tasks:deleteProject" as any },
  },
};

// When you have real generated types, replace the import in your components:
// import { api } from "@/convex/_generated/api";

