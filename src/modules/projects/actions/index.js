"use server";

import { inngest } from "@/inngest/client";
import db from "@/lib/db";
import { consumeCredits } from "@/lib/usage";
import { getCurrentUser } from "@/modules/auth/actions";
import { MessageRole, MessageType } from "@prisma/client";
import { generateSlug } from "random-word-slugs";

export const createProject = async (value) => {
  const user = await getCurrentUser();

  if (!user) throw new Error("Unauthorized");
  if (!value?.trim()) throw new Error("Project description is required");



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
    throw new Error("Unable to create project right now.");
  }

  const newProject = await db.project.create({
    data: {
      name: generateSlug(2, { format: "kebab" }),
      userId: user.id,
      messages: {
        create: {
          content: value,
          role: MessageRole.User,
          type: MessageType.RESULT,
        },
      },
    },
  });

  await inngest.send({
    name: "code-agent/run",
    data: {
      value: value,
      projectId: newProject.id,
    },
  });

  return newProject;
};

export const getProjects = async () => {
  const user = await getCurrentUser();

  if (!user) throw new Error("Unauthorized");

  const projects = await db.project.findMany({
    where: {
      userId: user.id,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return projects;
};

export const getProjectById = async (projectId) => {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  if (!projectId) throw new Error("Project ID is required");

  const project = await db.project.findFirst({
    where: {
      id: projectId,
      userId: user.id,
    },
  });

  if (!project) throw new Error("Project not found");

  return project;
};
