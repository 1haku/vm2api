import { createFileRoute } from '@tanstack/react-router'
import { SystemPromptPage } from '@/features/system'

export const Route = createFileRoute('/_authenticated/system')({
  component: SystemPromptPage,
})
