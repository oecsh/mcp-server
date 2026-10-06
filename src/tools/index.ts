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
import { createProject, deleteProject, getProject, listProjects, updateProject, updateProjectRepository } from "./projects.js";
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

  // Opt-in "destructive": full-access key, confirm argument (restore:
  // confirm_environment_name; webhook create, re-point and test: the host
  // the data goes to).
  deleteEnvironment,
  deleteProject,
  deleteWebhook,
  rotateWebhookSecret,
  revokeApiKey,
  reinitializeModules,
  restoreBackup,
  updateProjectRepository,

  // They send data to a URL the caller names, which injected text could
  // choose.
  createWebhook,
  updateWebhook,
  testWebhook,

  // Opt-in "backup-download": any key (the API serves it to read-only keys).
  getBackupDownloadLinks,
] as ToolDef[];
