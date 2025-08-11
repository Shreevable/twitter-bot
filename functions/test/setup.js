import { config } from 'dotenv';
import admin from 'firebase-admin';
import functions from 'firebase-functions-test';

// Load environment variables
config({ path: '.env.test' });

// Initialize Firebase Test SDK
const testEnv = functions({
  projectId: 'project-4261681351'
});

// Initialize Firebase Admin with a test app
admin.initializeApp({
  projectId: 'project-4261681351'
});

export { testEnv, admin };
