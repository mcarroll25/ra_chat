/**
 * OpenAI Service
 * Manages interactions with the OpenAI API
 */
import OpenAI from "openai";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

/**
 * Convert Claude/database message format to OpenAI format
 * @param {Array} messages - Messages in Claude format
 * @returns {Array} Messages in OpenAI format
 */

function convertToOpenAIFormat(messages) {
  return messages
    .filter(msg => {
      // Completely skip any message with system reminder content
      const msgContent = JSON.stringify(msg.content || '');
      if (msgContent.includes('long_conversation_reminder') ||
          msgContent.includes('Claude cares about') ||
          msgContent.includes('Claude never starts') ||
          msgContent.includes('Claude does not use') ||
          msgContent.includes('Claude critically evaluates') ||
          msgContent.includes('wellbeing')) {
        console.log('FILTERED OUT MESSAGE WITH SYSTEM CONTENT');
        return false;
      }
      return true;
    })
    .map(msg => {
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(block =>
          block.type === 'text' &&
          block.text &&
          !block.text.includes('long_conversation_reminder') &&
          !block.text.includes('<')
        );

        const textContent = textBlocks
          .map(block => block.text)
          .join('\n')
          .trim();

        return {
          role: msg.role,
          content: textContent || ''
        };
      }

      let content = msg.content || '';
      if (typeof content === 'string') {
        content = content.replace(/<long_conversation_reminder>[\s\S]*?<\/long_conversation_reminder>/g, '');
        content = content.trim();
      }

      return {
        role: msg.role,
        content: content
      };
    })
    .filter(msg => msg.content && msg.content.length > 0);
}

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
    const convertedMessages = convertToOpenAIFormat(messages);
    const openAIMessages = [
      { role: "system", content: systemInstruction },
      ...convertedMessages
    ];

    let fullContent = "";
    let finalMessage = null;

    try {
      // Create stream
      const stream = await openai.chat.completions.create({
        model: "gpt-4",
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

      // Use iterator instead of for await to avoid stream cancellation issues
      const iterator = stream[Symbol.asyncIterator]();
      debugger;
      while (true) {
        const { value: chunk, done } = await iterator.next();
        if (done) break;

        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          fullContent += delta.content;
          if (streamHandlers.onText) {
            streamHandlers.onText(delta.content);
          }
        }

        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            if (streamHandlers.onToolUse && toolCall.function?.arguments) {
              const args = toolCall.function.arguments.trim();
              // Only process complete JSON objects
              if (args.startsWith('{') && args.endsWith('}')) {
                try {
                  await streamHandlers.onToolUse({
                    type: "tool_use",
                    id: toolCall.id,
                    name: toolCall.function.name,
                    input: JSON.parse(args)
                  });
                } catch (e) {
                  // Skip incomplete tool calls
                  console.log('Skipping incomplete tool call');
                }
              }
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finalMessage = {
            role: "assistant",
            content: fullContent,
            stop_reason: "end_turn"
          };

          if (streamHandlers.onMessage) {
            streamHandlers.onMessage(finalMessage);
          }
          break;
        }
      }
    } catch (error) {
      console.error('OpenAI streaming error:', error);
      if (!finalMessage) {
        finalMessage = {
          role: "assistant",
          content: fullContent || "I'm having trouble processing that request.",
          stop_reason: "end_turn"
        };
      }
    }

    // Ensure we always return a message with stop_reason
    if (!finalMessage) {
      finalMessage = {
        role: "assistant",
        content: fullContent || "",
        stop_reason: "end_turn"
      };
    }

    if (!finalMessage.stop_reason) {
      finalMessage.stop_reason = "end_turn";
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