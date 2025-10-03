/**
 * Chat API Route
 * Handles chat interactions with Claude API and tools
 */
import { json } from "@remix-run/node";
import MCPClient from "../mcp-client";
import { saveMessage, getConversationHistory } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createClaudeService } from "../services/claude.server";
import { createToolService } from "../services/tool.server";
import { searchProductsFallback } from "../services/fallback-product-search.server";

/**
 * Remix loader function for handling GET requests
 */
export async function loader({ request }) {
  // Handle OPTIONS requests (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    });
  }

  const url = new URL(request.url);

  // Handle history fetch requests
  if (url.searchParams.has('history') && url.searchParams.has('conversation_id')) {
    return handleHistoryRequest(request, url.searchParams.get('conversation_id'));
  }

  // Handle SSE requests
  if (!url.searchParams.has('history') && request.headers.get("Accept") === "text/event-stream") {
    return handleChatRequest(request);
  }

  // API-only: reject all other requests
  return json(
    { error: AppConfig.errorMessages.apiUnsupported },
    { status: 400, headers: getCorsHeaders(request) }
  );
}

/**
 * Remix action function for handling POST requests
 */
export async function action({ request }) {
  return handleChatRequest(request);
}

/**
 * Handle history fetch requests
 */
async function handleHistoryRequest(request, conversationId) {
  try {
    const messages = await getConversationHistory(conversationId);
    return json(
      { messages },
      { headers: getCorsHeaders(request) }
    );
  } catch (error) {
    console.error('Error fetching history:', error);
    return json(
      { error: 'Failed to fetch conversation history' },
      { status: 500, headers: getCorsHeaders(request) }
    );
  }
}

/**
 * Handle chat requests (both GET and POST)
 */
async function handleChatRequest(request) {
  try {
    // Get message data from request body
    const body = await request.json();

    console.log('=== REQUEST BODY DEBUG ===');
    console.log('Full body:', JSON.stringify(body, null, 2));
    console.log('body.shop:', body.shop);
    console.log('body.message:', body.message);
    console.log('body.conversation_id:', body.conversation_id);
    console.log('========================');

    const userMessage = body.message;
    const shop = body.shop;

    // Validate required message
    if (!userMessage) {
      return new Response(
        JSON.stringify({ error: AppConfig.errorMessages.missingMessage }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    // Generate or use existing conversation ID
    const conversationId = body.conversation_id || Date.now().toString();
    const promptType = body.prompt_type || AppConfig.api.defaultPromptType;

    // Create a stream for the response
    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        request,
        userMessage,
        conversationId,
        promptType,
        shop,
        stream
      });
    });

    return new Response(responseStream, {
      headers: getSseHeaders(request)
    });
  } catch (error) {
    console.error('Error in chat request handler:', error);
    return json({
      error: error.message || 'Internal server error'
    }, {
      status: 500,
      headers: getCorsHeaders(request)
    });
  }
}

/**
 * Handle a complete chat session
 */
async function handleChatSession({
  request,
  userMessage,
  conversationId,
  promptType,
  shop,
  stream
}) {
  // Initialize services
  const claudeService = createClaudeService();
  const toolService = createToolService();

  // Use shop from parameter or fallback
  if (!shop) {
    shop = 'restorair.myshopify.com';
    console.log('⚠️  No shop parameter, using hardcoded fallback:', shop);
  } else {
    console.log('✓ Using shop from request:', shop);
  }

  const hostUrl = `https://${shop}`;

  // Initialize MCP client
  let mcpClient;
  let availableTools = [];
  let useFallbackTools = false;

  try {
    console.log(`Initializing MCP client for shop: ${shop}`);
    mcpClient = new MCPClient(hostUrl, conversationId, shop, null);

    // Try to connect to both MCP servers
    try {
      const storefrontTools = await mcpClient.connectToStorefrontServer();
      console.log(`✓ Connected to storefront MCP, got ${storefrontTools.length} tools`);
      if (storefrontTools.length > 0) {
        console.log('Storefront tools:', storefrontTools.map(t => t.name).join(', '));
      }
    } catch (e) {
      console.warn("✗ Could not connect to storefront MCP server:", e.message);
      useFallbackTools = true;
    }

    try {
      const customerTools = await mcpClient.connectToCustomerServer();
      console.log(`✓ Connected to customer MCP, got ${customerTools.length} tools`);
      if (customerTools.length > 0) {
        console.log('Customer tools:', customerTools.map(t => t.name).join(', '));
      }
    } catch (e) {
      console.warn("✗ Could not connect to customer MCP server:", e.message);
    }

    availableTools = mcpClient.tools;

    // If MCP has no tools, use fallback
    if (availableTools.length === 0) {
      console.log('🔄 No MCP tools available, enabling fallback');
      useFallbackTools = true;
      availableTools = [{
        name: "search_shop_catalog",
        description: "Search the store's product catalog. Use this when customers ask about available products, pricing, or features.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for products"
            }
          },
          required: ["query"]
        }
      }];
    }

    console.log(`📦 Total tools available: ${availableTools.length}`);
  } catch (error) {
    console.error("❌ Error initializing MCP client:", error);
    useFallbackTools = true;
    availableTools = [{
      name: "search_shop_catalog",
      description: "Search the store's product catalog.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" }
        },
        required: ["query"]
      }
    }];
  }

  try {
    // Send conversation ID to client
    stream.sendMessage({ type: 'id', conversation_id: conversationId });

    // Save user message to the database
    await saveMessage(conversationId, 'user', userMessage);

    // Fetch all messages from the database for this conversation
    const dbMessages = await getConversationHistory(conversationId);

    // Remove duplicate consecutive messages
    const deduplicatedMessages = [];
    for (let i = 0; i < dbMessages.length; i++) {
      const current = dbMessages[i];
      const previous = dbMessages[i - 1];

      if (!previous || current.content !== previous.content || current.role !== previous.role) {
        deduplicatedMessages.push(current);
      }
    }

    // Limit to last 20 messages to avoid token limits
    const recentMessages = deduplicatedMessages.slice(-20);

    // Format messages for Claude API
    const conversationHistory = recentMessage.map(dbMessage => {
      let content;
      try {
        content = JSON.parse(dbMessage.content);
      } catch (e) {
        content = dbMessage.content;
      }

        // Ensure content is always an array for Claude
      if (typeof content === 'string') {
        content = [{ type: 'text', text: content }];
      } else if (!Array.isArray(content)) {
        content = [{ type: 'text', text: String(content) }];
      }

      return {
        role: dbMessage.role,
        content
      };
    });

    // Products to display (if any tool returns products)
    const productsToDisplay = [];

    // Track if we need to continue the conversation after tool use
    let needsContinuation = false;

    // Execute the conversation stream - may need multiple iterations for tool use
    do {
      needsContinuation = false;

      await claudeService.streamConversation(
        {
          messages: conversationHistory,
          promptType,
          tools: availableTools.length > 0 ? availableTools : undefined
        },
        {
          // Handle text chunks
          onText: (textDelta) => {
            stream.sendMessage({
              type: 'chunk',
              chunk: textDelta
            });
          },

          // Handle complete messages
          onMessage: (message) => {
            console.log('Message complete, stop reason:', message.stop_reason);

            conversationHistory.push({
              role: message.role,
              content: message.content
            });

            saveMessage(conversationId, message.role, JSON.stringify(message.content))
              .catch((error) => {
                console.error("Error saving message to database:", error);
              });

            // Send products if any were found
            if (productsToDisplay.length > 0) {
              console.log(`Sending ${productsToDisplay.length} products to frontend`);
              stream.sendMessage({
                type: 'products',
                products: productsToDisplay
              });
              // Clear products array after sending
              productsToDisplay.length = 0;
            }

            // Send a completion message
            stream.sendMessage({ type: 'message_complete' });
          },

          // Handle tool use (if tools are enabled)
          onToolUse: async (toolUse) => {
            console.log('Tool use requested:', toolUse.name);

            stream.sendMessage({
              type: 'tool_use',
              tool_name: toolUse.name,
              tool_input: toolUse.input
            });

            // Execute the tool - use MCP or fallback
            try {
              let toolResult;

              if (useFallbackTools && toolUse.name === 'search_shop_catalog') {
                console.log('Using fallback product search');
                toolResult = await searchProductsFallback(request, toolUse.input.query);
              } else if (mcpClient) {
                console.log('Using MCP client');
                toolResult = await mcpClient.callTool(toolUse.name, toolUse.input);
                console.log('MCP tool result:', JSON.stringify(toolResult).substring(0, 500));
              } else {
                throw new Error("No tool execution method available");
              }

              // Check if result has error
              if (toolResult.error) {
                await toolService.handleToolError(
                  toolResult,
                  toolUse.name,
                  toolUse.id,
                  conversationHistory,
                  stream.sendMessage,
                  conversationId
                );

              } else {
                console.log('Raw tool result:', JSON.stringify(toolResult).substring(0, 500));

                // Pass the RAW tool result to extract products
                await toolService.handleToolSuccess(
                  toolResult,  // ← CORRECT - pass raw result
                  toolUse.name,
                  toolUse.id,
                  conversationHistory,
                  productsToDisplay,
                  conversationId
                );

                // Set flag to continue conversation after tool use
                needsContinuation = true;
              }
            } catch (error) {
              console.error('Tool execution error:', error);
              await toolService.handleToolError(
                { error: { type: 'execution_error', data: error.message } },
                toolUse.name,
                toolUse.id,
                conversationHistory,
                stream.sendMessage,
                conversationId
              );
            }
          }
        }
      );

    } while (needsContinuation);

    // Signal end of turn
    stream.sendMessage({ type: 'end_turn' });

  } catch (error) {
    console.error('Error in chat session:', error);
    stream.handleStreamingError(error);
    throw error;
  }
}

/**
 * Gets CORS headers for the response
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders = request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400"
  };
}

/**
 * Get SSE headers for the response
 */
function getSseHeaders(request) {
  const origin = request.headers.get("Origin") || "*";

  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS,POST",
    "Access-Control-Allow-Headers": "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  };
}