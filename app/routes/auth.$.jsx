import  shopify  from "../shopify.server";

export const loader = async ({ request }) => {
  await shopify.authenticate.admin(request);

  return null;
};
