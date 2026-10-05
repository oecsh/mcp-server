import {
  deployEnvironment,
  quickUpdateEnvironment,
  reinitializeModules,
  restartEnvironment,
  startEnvironment,
  stopEnvironment,
} from "./actions.js";
import { createBackup, getBackup, getBackupDownloadLinks, listBackups, restoreBackup } from "./backups.js";
import type { ToolDef } from "./define.js";
import { createEnvironment, deleteEnvironment, getEnvironment, listEnvironments, updateEnvironment } from "./environments.js";
import { getEnvironmentMetrics, getRuntimeLogs, getServerMetrics } from "./observability.js";
import { getOrganization, revokeApiKey } from "./org.js";
import { createProject, deleteProject, getProject, listProjects, updateProject } from "./projects.js";
import { getServer, listServers } from "./servers.js";
import { getTask, getTaskLog, listDeployments, waitForTask } from "./tasks.js";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhookDeliveries,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
} from "./webhooks.js";

// Every tool the server knows. server.ts picks the ones the key's tier and
// the opt-ins allow; nothing else decides what is exposed.
//
// Server registration tokens are deliberately absent: they let a key enrol
// billable servers, which stays a dashboard decision.
export const ALL_TOOLS: readonly ToolDef[] = [
  // Read: any key.
  getOrganization,
  listServers,
  getServer,
  getServerMetrics,
  listProjects,
  getProject,
  listEnvironments,
  getEnvironment,
  getEnvironmentMetrics,
  getRuntimeLogs,
  listDeployments,
  getTask,
  waitForTask,
  getTaskLog,
  listBackups,
  getBackup,
  listWebhooks,
  getWebhook,
  listWebhookDeliveries,

  // Write: full-access key; none of these deletes data.
  deployEnvironment,
  restartEnvironment,
  startEnvironment,
  stopEnvironment,
  quickUpdateEnvironment,
  createBackup,
  createProject,
  updateProject,
  createEnvironment,
  updateEnvironment,
  createWebhook,
  updateWebhook,
  testWebhook,

  // Opt-in "destructive": full-access key, confirm argument (restore:
  // confirm_environment_name).
  deleteEnvironment,
  deleteProject,
  deleteWebhook,
  rotateWebhookSecret,
  revokeApiKey,
  reinitializeModules,
  restoreBackup,

  // Opt-in "backup-download": any key (the API serves it to read-only keys).
  getBackupDownloadLinks,
] as ToolDef[];
