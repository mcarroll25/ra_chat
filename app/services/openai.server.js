/**
 * OpenAI Service
 * Manages interactions with the OpenAI API
 */
import OpenAI from "openai";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

/**
 * Creates an OpenAI service instance
 * @param {string} apiKey - OpenAI API key
 * @returns {Object} OpenAI service with methods for interacting with OpenAI API
 */
export function createOpenAIService(apiKey = process.env.OPENAI_API_KEY) {
  // Initialize OpenAI client
  const openai = new OpenAI({ apiKey });

  /**
   * Streams a conversation with OpenAI
   * @param {Object} params - Stream parameters
   * @param {Array} params.messages - Conversation history
   * @param {string} params.promptType - The type of system prompt to use
   * @param {Array} params.tools - Available tools for OpenAI
   * @param {Object} streamHandlers - Stream event handlers
   * @param {Function} streamHandlers.onText - Handles text chunks
   * @param {Function} streamHandlers.onMessage - Handles complete messages
   * @param {Function} streamHandlers.onToolUse - Handles tool use requests
   * @returns {Promise<Object>} The final message
   */
  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools
  }, streamHandlers) => {
    // Get system prompt and add it as first message
    const systemInstruction = getSystemPrompt(promptType);

    // OpenAI format: system message goes in messages array
    const openAIMessages = [
      { role: "system", content: systemInstruction },
      ...messages.map(msg => ({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content
      }))
    ];

    // Create stream
    const stream = await openai.chat.completions.create({
      model: "gpt-4", // or "gpt-3.5-turbo"
      messages: openAIMessages,
      stream: true,
      tools: tools && tools.length > 0 ? tools.map(tool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      })) : undefined
    });

    let fullContent = "";
    let finalMessage = null;

    // Process stream
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        fullContent += delta.content;
        if (streamHandlers.onText) {
          streamHandlers.onText(delta.content);
        }
      }

      if (delta?.tool_calls) {
        // Handle tool calls
        for (const toolCall of delta.tool_calls) {
          if (streamHandlers.onToolUse && toolCall.function) {
            await streamHandlers.onToolUse({
              type: "tool_use",
              id: toolCall.id,
              name: toolCall.function.name,
              input: JSON.parse(toolCall.function.arguments || "{}")
            });
          }
        }
      }

      if (chunk.choices[0]?.finish_reason) {
        finalMessage = {
          role: "assistant",
          content: fullContent
        };

        if (streamHandlers.onMessage) {
          streamHandlers.onMessage(finalMessage);
        }
      }
    }

    return finalMessage;
  };

  /**
   * Gets the system prompt content for a given prompt type
   * @param {string} promptType - The prompt type to retrieve
   * @returns {string} The system prompt content
   */
  const getSystemPrompt = (promptType) => {
    return systemPrompts.systemPrompts[promptType]?.content ||
      systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content;
  };

  return {
    streamConversation,
    getSystemPrompt
  };
}

export default { createOpenAIService };