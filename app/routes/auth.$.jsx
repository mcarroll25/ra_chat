import  shopify  from "../shopify.server";

export const loader = async ({ request }) => {
  await shopify.login(request);

  return null;
};
