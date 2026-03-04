

# AGENTS.md

## Project
LogicK — AI Code Generation Platform

## Purpose
This repository powers an AI application builder similar to v0.dev or bolt.new.

Users type a prompt and the system generates a working Next.js application inside a sandbox environment and shows a live preview.

This file defines **rules, architecture, and constraints** that AI agents (Codex, Cursor, Claude, etc.) must follow when modifying this repository.

Agents must respect these constraints to avoid breaking the system architecture.

---

# System Architecture

User Prompt
↓
React UI
↓
Server Action (createMessages)
↓
Prisma Database (Message table)
↓
Inngest Event (code-agent/run)
↓
AI Agent (Gemini)
↓
E2B Sandbox
↓
Files generated
↓
Fragment saved to database
↓
Preview rendered in UI

---

# Tech Stack

Frontend
- Next.js 16 (App Router)
- React 19
- Tailwind CSS
- React Query

Backend
- Prisma ORM
- PostgreSQL

AI / Background Jobs
- Inngest
- Gemini API (Google Generative AI)

Execution Environment
- E2B Code Interpreter Sandbox

Authentication
- Clerk

---

# Repository Rules

## 1. AI Execution Location

All AI generation must run **inside Inngest functions**.

Never call Gemini directly from:
- React components
- client code
- frontend hooks

Correct flow:

React UI  
→ server action  
→ database write  
→ Inngest event  
→ AI execution

---

## 2. Server Action for Prompts

User prompts must always pass through:

createMessages(value, projectId)

This function must:

1. validate the user
2. store the message in the database
3. trigger the Inngest event

Example flow:

User Prompt  
↓  
createMessages()  
↓  
db.message.create()  
↓  
inngest.send()

---

## 3. Inngest Event

Event name:

code-agent/run

The Inngest function is responsible for:

• reading the user prompt  
• generating code using Gemini  
• writing files to the sandbox  
• saving the fragment to the database  

---

## 4. Prisma Data Models

Important tables:

User  
Project  
Message  
Fragment  
Usage

Fragments store:

sandboxUrl  
title  
files

Files must be stored as JSON.

Example:

```
{
  "app/page.tsx": "...",
  "components/navbar.tsx": "..."
}
```

Agents must **not modify the Prisma schema unless absolutely required**.

---

## 5. Sandbox Rules

All generated code must be written using:

createOrUpdateFiles tool

Paths must always be **relative paths**.

Correct:

app/page.tsx  
components/button.tsx  

Incorrect:

/home/user/app/page.tsx  
/home/user/components/button.tsx  

Absolute paths will break sandbox execution.

---

## 6. UI Rendering

The frontend reads messages via:

getMessages(projectId)

Fragments are attached to assistant messages.

The preview loads using:

fragment.sandboxUrl

---

## 7. Error Handling

If code generation fails:

MessageType = ERROR

If generation succeeds:

MessageType = RESULT

---

# Development Conventions

Use:

- TypeScript
- async / await
- Prisma db client
- React Query for fetching
- modular React components

Avoid:

- raw fetch calls when server actions exist
- rewriting working architecture
- changing database schema unnecessarily
- executing dev servers inside sandbox

---

# Sandbox Environment

The sandbox already runs a Next.js development server.

Agents MUST NOT run:

npm run dev  
next dev  
next start  

The server already runs and will hot reload automatically.

---

# Expected Project Commands

The project must run using:

npm install  
npm run dev

---

# Debugging Priorities

When repairing the project, agents should check:

1. Inngest function execution
2. Gemini API authentication
3. sandbox file creation
4. fragment database storage
5. UI preview rendering

---

# Primary Goal

Ensure the full generation pipeline works:

User Prompt  
→ message saved  
→ Inngest event triggered  
→ Gemini generates code  
→ files written to sandbox  
→ fragment saved to database  
→ preview rendered in UI

---

# Agent Behavior

When modifying the repository:

1. Prefer minimal changes
2. Preserve architecture
3. Maintain Prisma schema compatibility
4. Fix root causes rather than symptoms
5. Keep Next.js App Router structure intact

Agents should prioritize **stability and correctness over rewriting code**.

---

# End of File