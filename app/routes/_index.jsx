import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { login } from "../shopify.server"; // Updated path (removed one ../level)
import styles from "./_index.module.css"; // Updated CSS import

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Index() { // Changed from "App" to "Index"
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Shop chat agent reference app</h1>
        <p className={styles.text}>
          A reference app for shop chat agent.
        </p>
        {showForm && (
          <div>
            <p>Please access this app through your Shopify Admin.</p>
          </div>
        )}
      </div>
    </div>
  );
}