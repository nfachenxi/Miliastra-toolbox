export interface LLMConfig {
  api_key: string
  api_base_url: string
  model: string
  use_default_model: number
  context_length: number
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  imageBase64?: string
  imageBase64s?: string[]
}

export interface Source {
  title: string
  doc_id: string
  similarity: number
  text_snippet: string
  url: string
}

export interface ToolTrace {
  tool: string
  args: Record<string, string | number | boolean>
  status: 'success' | 'error'
  summary: string
  sources?: { title: string; url: string }[]
}

export interface Conversation {
  id: string
  title: string
  messages: any[] // ChatMessage[] - includes both ExtendedMessage and SourceMessage
  createdAt: number
  updatedAt: number
}

export type Tab = 'chat' | 'tools' | 'data' | 'svg'

export interface COSConfig {
  useDefault: boolean
}

