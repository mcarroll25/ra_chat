/**
 * Fallback Product Search using Shopify Admin API with session auth
 * Used when MCP is not available
 */
import { authenticate } from "../shopify.server";

/**
 * Search products using Shopify Admin API with request authentication
 * @param {Request} request - The request object for authentication
 * @param {string} query - Search query
 * @returns {Promise<Object>} Search results
 */
export async function searchProductsFallback(request, query) {
  try {
    // Authenticate using the same method as the rest of the app
    const { admin } = await authenticate.public.appProxy(request);

    const graphqlQuery = `
      query searchProducts($query: String!, $first: Int!) {
        products(first: $first, query: $query) {
          edges {
            node {
              id
              title
              description
              handle
              onlineStoreUrl
              featuredImage {
                url
                altText
              }
              priceRangeV2 {
                minVariantPrice {
                  amount
                  currencyCode
                }
                maxVariantPrice {
                  amount
                  currencyCode
                }
              }
              variants(first: 5) {
                edges {
                  node {
                    id
                    title
                    price
                    availableForSale
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await admin.graphql(graphqlQuery, {
      variables: {
        query: query,
        first: 5
      }
    });

    const data = await response.json();

    if (data.errors) {
      console.error('GraphQL errors:', data.errors);
      return {
        error: {
          type: "api_error",
          data: "Failed to search products"
        }
      };
    }

    // Format products
    const products = data.data.products.edges.map(({ node }) => {
      const minPrice = node.priceRangeV2.minVariantPrice;
      const maxPrice = node.priceRangeV2.maxVariantPrice;

      return {
        product_id: node.id,
        title: node.title,
        description: node.description || '',
        url: node.onlineStoreUrl || '',
        image_url: node.featuredImage?.url || '',
        price_range: {
          min: minPrice.amount,
          max: maxPrice.amount,
          currency: minPrice.currencyCode
        },
        variants: node.variants.edges.map(({ node: variant }) => ({
          id: variant.id,
          title: variant.title,
          price: variant.price,
          available: variant.availableForSale
        }))
      };
    });

    console.log(`✓ Found ${products.length} products for query: "${query}"`);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          products,
          total_found: products.length,
          query: query
        })
      }]
    };

  } catch (error) {
    console.error('Error in fallback product search:', error);
    return {
      error: {
        type: "execution_error",
        data: error.message
      }
    };
  }
}