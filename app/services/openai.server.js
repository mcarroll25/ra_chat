/**
 * OpenAI Service
 * Manages interactions with the OpenAI API
 */
import OpenAI from "openai";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";

/**
 * Filter out system reminder content from text
 * @param {string} text - Text to filter
 * @returns {string} Filtered text
 */
function filterSystemContent(text) {
  if (!text) return '';

  // Remove long_conversation_reminder tags and everything inside
  let filtered = text.replace(/<long_conversation_reminder>[\s\S]*?<\/long_conversation_reminder>/g, '');

  // Remove other system patterns
  filtered = filtered.replace(/Claude cares about[\s\S]*?even in these circumstances\./g, '');
  filtered = filtered.replace(/Claude never starts[\s\S]*?positive adjective\./g, '');
  filtered = filtered.replace(/Claude does not use emojis[\s\S]*?these circumstances\./g, '');
  filtered = filtered.replace(/Claude avoids the use[\s\S]*?communication\./g, '');
  filtered = filtered.replace(/Claude critically evaluates[\s\S]*?own opinion\./g, '');
  filtered = filtered.replace(/If Claude notices[\s\S]*?harmless thinking\./g, '');
  filtered = filtered.replace(/Claude provides honest[\s\S]*?in the moment\./g, '');
  filtered = filtered.replace(/Claude tries to maintain[\s\S]*?actual identity\./g, '');

  return filtered.trim();
}

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
      // Handle assistant messages with tool_calls (content can be null)
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls
        };
      }

      // Handle tool result messages
      if (msg.role === 'tool') {
        return {
          role: msg.role,
          tool_call_id: msg.tool_call_id,
          content: msg.content
        };
      }

      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(block =>
          block.type === 'text' &&
          block.text &&
          !block.text.includes('long_conversation_reminder') &&
          !block.text.includes('<')
        );

        const textContent = textBlocks
          .map(block => filterSystemContent(block.text))
          .join('\n')
          .trim();

        return {
          role: msg.role,
          content: textContent || ''
        };
      }

      let content = msg.content || '';
      if (typeof content === 'string') {
        content = filterSystemContent(content);
      }

      return {
        role: msg.role,
        content: content
      };
    })
    .filter(msg => {
      // Keep tool messages and assistant messages with tool_calls even if content is empty
      if (msg.role === 'tool' || (msg.role === 'assistant' && msg.tool_calls)) {
        return true;
      }
      // For other messages, require non-empty content
      return msg.content && msg.content.length > 0;
    });
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

    console.log('Messages being sent to OpenAI:', openAIMessages.length);
    console.log('Message roles:', openAIMessages.map(m => m.role).join(', '));
    // Log last 3 messages for debugging
    console.log('Last 3 messages:', JSON.stringify(openAIMessages.slice(-3), null, 2).substring(0, 500));

    let fullContent = "";
    let finalMessage = null;
    let toolCallsBuffer = {}; // Buffer for accumulating tool call arguments

    try {
      // Create stream
      const stream = await openai.chat.completions.create({
        model: "gpt-4",
        messages: openAIMessages,
        stream: true,
        ...(tools && tools.length > 0 ? {
          tools: tools.map(tool => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema
            }
          }))
        } : {})
      });

      // Use iterator to avoid stream cancellation issues
      const iterator = stream[Symbol.asyncIterator]();

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

        // Accumulate tool call arguments (they come in chunks)
        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index;

            if (!toolCallsBuffer[index]) {
              toolCallsBuffer[index] = {
                id: toolCall.id,
                name: toolCall.function?.name || '',
                arguments: ''
              };
            }

            if (toolCall.function?.name) {
              toolCallsBuffer[index].name = toolCall.function.name;
            }

            if (toolCall.function?.arguments) {
              toolCallsBuffer[index].arguments += toolCall.function.arguments;
            }
          }
        }

        // When stream finishes, process complete tool calls
        if (chunk.choices[0]?.finish_reason === 'tool_calls') {
          console.log('OpenAI wants to use tools');

          // Build the assistant message with tool_calls
          const assistantMessage = {
            role: "assistant",
            content: null,
            tool_calls: Object.values(toolCallsBuffer).map(call => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.arguments
              }
            }))
          };

          // Process tool calls for execution
          if (Object.keys(toolCallsBuffer).length > 0) {
            for (const bufferedCall of Object.values(toolCallsBuffer)) {
              if (streamHandlers.onToolUse && bufferedCall.arguments) {
                try {
                  const parsedArgs = JSON.parse(bufferedCall.arguments);
                  await streamHandlers.onToolUse({
                    type: "tool_use",
                    id: bufferedCall.id,
                    name: bufferedCall.name,
                    input: parsedArgs,
                    assistantMessage: assistantMessage // Pass the full assistant message
                  });
                } catch (e) {
                  console.error('Error parsing complete tool arguments:', e);
                }
              }
            }
          }
          // Don't break - let the loop continue
        } else if (chunk.choices[0]?.finish_reason === 'stop') {
          console.log('OpenAI finished with stop reason, content length:', fullContent.length);

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
          content: filterSystemContent(fullContent) || "I'm having trouble processing that request.",
          stop_reason: "end_turn"
        };
      }
    }

    // Ensure we always return a message with stop_reason
    if (!finalMessage) {
      finalMessage = {
        role: "assistant",
        content: filterSystemContent(fullContent) || "",
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