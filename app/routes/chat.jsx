/**
 * Chat API Route
 * Handles chat interactions with OpenAI API and tools
 */
import { json } from "@remix-run/node";
import MCPClient from "../mcp-client";
import { saveMessage, getConversationHistory } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createOpenAIService } from "../services/openai.server";
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

    // Debug logging
    console.log('=== REQUEST BODY DEBUG ===');
    console.log('Full body:', JSON.stringify(body, null, 2));
    console.log('body.shop:', body.shop);
    console.log('body.message:', body.message);
    console.log('body.conversation_id:', body.conversation_id);
    console.log('========================');

    const userMessage = body.message;
    const shop = body.shop; // Get shop from request body

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
        shop, // Pass shop to session handler
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
  shop, // Get shop from parameter
  stream
}) {
  // Initialize services
  const openaiService = createOpenAIService();
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
        description: "Search the store's product catalog for air purifiers and related products. Use this when customers ask about available products, pricing, or features.",
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
      description: "Search the store's product catalog for air purifiers and related products.",
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

    // Format messages for OpenAI API
    const conversationHistory = deduplicatedMessages.map(dbMessage => {
      let content;
      try {
        content = JSON.parse(dbMessage.content);
      } catch (e) {
        content = dbMessage.content;
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

      await openaiService.streamConversation(
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
          // Log the message content for debugging
          console.log('Message complete, content length:',
            typeof message.content === 'string' ? message.content.length : 'not a string');

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
              // Use fallback GraphQL search with request auth
              console.log('Using fallback product search with session auth');
              toolResult = await searchProductsFallback(request, toolUse.input.query);
            } else if (mcpClient) {
              // Use MCP
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
              // For OpenAI, tool results need to be added as messages with role "tool"
              // Extract the actual content
              let toolResultContent = '';
              if (toolResult.content && Array.isArray(toolResult.content)) {
                toolResultContent = toolResult.content[0]?.text || JSON.stringify(toolResult);
              } else {
                toolResultContent = JSON.stringify(toolResult);
              }

              console.log('Tool result content length:', toolResultContent.length);

              // Add tool result to conversation in OpenAI format
              conversationHistory.push({
                role: "tool",
                tool_call_id: toolUse.id,
                content: toolResultContent
              });

              // Save to database
              await saveMessage(conversationId, 'tool', JSON.stringify({
                tool_call_id: toolUse.id,
                content: toolResultContent
              })).catch((error) => {
                console.error("Error saving tool result to database:", error);
              });

              // Process products if this was a product search
              if (toolUse.name === 'search_shop_catalog') {
                try {
                  const resultData = JSON.parse(toolResultContent);
                  if (resultData.products && Array.isArray(resultData.products)) {
                    console.log(`Found ${resultData.products.length} products in tool result`);
                    productsToDisplay.push(...resultData.products.slice(0, AppConfig.tools.maxProductsToDisplay));
                  }
                } catch (e) {
                  console.error('Error parsing product data:', e);
                }
              }

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

    } while (needsContinuation); // Continue if tools were used

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