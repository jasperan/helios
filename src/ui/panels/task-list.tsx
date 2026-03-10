import React from "react";
import { Box, Text } from "ink";
import { C, G } from "../theme.js";
import type { TaskInfo } from "../layout.js";

interface TaskListPanelProps {
  tasks?: TaskInfo[];
  width?: number;
}

export function TaskListPanel({ tasks = [], width }: TaskListPanelProps) {
  const panelWidth = width ?? (Math.floor((process.stdout.columns || 80) * 0.4) - 4);
  // icon(1) + space(1) + machineId(~8) + space(1) = ~11 overhead
  const nameWidth = Math.max(10, panelWidth - 11);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {tasks.length === 0 ? (
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Text color={C.dim} dimColor>
            no tasks
          </Text>
        </Box>
      ) : (
        tasks.slice(0, 5).map((task) => {
          const name = task.name.length > nameWidth
            ? task.name.slice(0, nameWidth - 1) + "…"
            : task.name;
          return (
            <Box key={task.id} paddingLeft={1}>
              <Text color={statusColor(task.status)}>
                {statusIcon(task.status)}{" "}
              </Text>
              <Text color={C.dim}>{task.machineId} </Text>
              <Text color={C.text}>{name}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return G.dot;
    case "completed":
      return G.dot;
    case "failed":
      return G.active;
    default:
      return G.bullet;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return C.primary;
    case "completed":
      return C.success;
    case "failed":
      return C.error;
    default:
      return C.dim;
  }
}
