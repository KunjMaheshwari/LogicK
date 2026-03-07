"use server";

import { MessageRole, MessageType } from "@prisma/client";
import db from "@/lib/db";
import { inngest } from "@/inngest/client";
import { getCurrentUser } from "@/modules/auth/actions";
import { consumeCredits } from "@/lib/usage";

export const createMessages = async (value, projectId) => {
  const user = await getCurrentUser();

  if (!user) throw new Error("Unauthorized");
  if (!value?.trim()) throw new Error("Message content is required");
  if (!projectId) throw new Error("Project ID is required");

  const project = await db.project.findFirst({
    where: {
      id: projectId,
      userId: user.id,
    },
  });

  if (!project) throw new Error("Project not found");


  try {
    await consumeCredits();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "remainingPoints" in error
    ) {
      throw new Error("Too many requests. Please try again later.");
    }
    throw new Error("Unable to process your request right now.");
  }

  try {
    const newMessage = await db.message.create({
      data: {
        projectId: projectId,
        content: value,
        role: MessageRole.User,
        type: MessageType.RESULT,
      },
    });

    await inngest.send({
      name: "code-agent/run",
      data: {
        value: value,
        projectId: projectId,
      },
    });

    return newMessage;
  } catch (error) {
    console.error("Failed to create message or trigger workflow", error);
    throw new Error("Unable to process message right now.");
  }
};

export const getMessages = async (projectId) => {
  const user = await getCurrentUser();

  if (!user) throw new Error("Unauthorized");
  if (!projectId) throw new Error("Project ID is required");

  const project = await db.project.findFirst({
    where: {
      id: projectId,
      userId: user.id,
    },
  });

  if (!project) throw new Error("Project not found or unauthorized");

  const messages = await db.message.findMany({
    where:{
        projectId
    },
    orderBy:{
        createdAt:"asc"
    },
    include:{
        fragments:true
    }
  })

  return messages;
};
