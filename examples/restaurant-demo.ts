import "dotenv/config";
import { connect, createTableDB, TableSchema } from "../src";

/**
 * Restaurant App Example - Using FileBasedTableDB as an SQL-like layer
 * 
 * This demonstrates how to use the SQL mapper to organize cloud storage
 * as tables with records, perfect for restaurant admin operations.
 */
async function runRestaurantApp(): Promise<void> {
  const provider = process.env.FILEBASEDB_PROVIDER as "google" | "onedrive";
  const folderId = process.env.FILEBASEDB_FOLDER_ID;

  if (!provider || !folderId) {
    throw new Error(
      "Set FILEBASEDB_PROVIDER, FILEBASEDB_FOLDER_ID in your environment"
    );
  }

  // Step 1: Connect to cloud storage
  console.log("🔗 Connecting to cloud storage...");
  const credentials: any =
    provider === "google"
      ? {
          accessToken: process.env.GOOGLE_ACCESS_TOKEN,
          refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        }
      : {
          accessToken: process.env.ONEDRIVE_ACCESS_TOKEN || "",
        };

  const db = await connect(provider, credentials);
  await db.useFolder(folderId);
  console.log(`✅ Connected to ${provider} folder\n`);

  // Step 2: Initialize table database
  console.log("📊 Initializing table-based database...");
  const tables = await createTableDB(db);

  // Step 3: Define table schemas
  const userSchema: TableSchema = {
    tableName: "users",
    columns: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      role: { type: "string" },
      createdAt: { type: "date" },
    },
    primaryKey: "id",
  };

  const menuItemSchema: TableSchema = {
    tableName: "menu_items",
    columns: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      price: { type: "number" },
      category: { type: "string" },
      available: { type: "boolean" },
    },
    primaryKey: "id",
  };

  const orderSchema: TableSchema = {
    tableName: "orders",
    columns: {
      id: { type: "string" },
      userId: { type: "string" },
      items: { type: "string" }, // JSON stringified array
      totalAmount: { type: "number" },
      status: { type: "string" },
      createdAt: { type: "date" },
    },
    primaryKey: "id",
  };

  // Step 4: Create tables
  console.log("📝 Creating tables...");
  try {
    await tables.createTable(userSchema);
    console.log("  ✓ Created 'users' table");
  } catch {
    console.log("  ✓ 'users' table already exists");
  }

  try {
    await tables.createTable(menuItemSchema);
    console.log("  ✓ Created 'menu_items' table");
  } catch {
    console.log("  ✓ 'menu_items' table already exists");
  }

  try {
    await tables.createTable(orderSchema);
    console.log("  ✓ Created 'orders' table");
  } catch {
    console.log("  ✓ 'orders' table already exists");
  }
  console.log();

  // Step 5: Insert sample data
  console.log("➕ Inserting sample data...");

  const adminId = await tables.insert("users", {
    id: "user-admin-001",
    name: "Chef Mario",
    email: "mario@restaurant.com",
    role: "admin",
    createdAt: new Date().toISOString(),
  });
  console.log(`  ✓ Added admin user: ${adminId}`);

  const customerId = await tables.insert("users", {
    id: "user-customer-001",
    name: "Alice Johnson",
    email: "alice@example.com",
    role: "customer",
    createdAt: new Date().toISOString(),
  });
  console.log(`  ✓ Added customer: ${customerId}`);

  const item1 = await tables.insert("menu_items", {
    id: "item-001",
    name: "Margherita Pizza",
    description: "Classic pizza with tomato and mozzarella",
    price: 9.99,
    category: "pizza",
    available: true,
  });
  console.log(`  ✓ Added menu item: ${item1}`);

  const item2 = await tables.insert("menu_items", {
    id: "item-002",
    name: "Caesar Salad",
    description: "Fresh salad with croutons and parmesan",
    price: 6.99,
    category: "salad",
    available: true,
  });
  console.log(`  ✓ Added menu item: ${item2}`);

  const orderId = await tables.insert("orders", {
    id: "order-001",
    userId: "user-customer-001",
    items: JSON.stringify(["item-001", "item-002"]),
    totalAmount: 16.98,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  console.log(`  ✓ Created order: ${orderId}\n`);

  // Step 6: Query data
  console.log("🔍 Querying data...");

  const allUsers = await tables.query("users");
  console.log(`  📊 Total users: ${allUsers.length}`);
  console.log(
    `     Admins: ${allUsers.filter((u) => u.role === "admin").length}`
  );
  console.log(
    `     Customers: ${allUsers.filter((u) => u.role === "customer").length}`
  );

  const availableItems = await tables.query("menu_items", {
    available: true,
  });
  console.log(`  📋 Available menu items: ${availableItems.length}`);

  const pizzas = await tables.query("menu_items", { category: "pizza" });
  console.log(`  🍕 Pizza items: ${pizzas.length}`);

  const orders = await tables.query("orders");
  console.log(`  📦 Total orders: ${orders.length}\n`);

  // Step 7: Update data
  console.log("✏️  Updating data...");
  await tables.update("orders", "order-001", {
    status: "completed",
  });
  console.log("  ✓ Updated order status to 'completed'");

  await tables.update("menu_items", "item-002", {
    available: false,
  });
  console.log("  ✓ Marked Caesar Salad as unavailable\n");

  // Step 8: Verify updates
  console.log("📌 Verifying updates...");
  const updatedOrder = await tables.read("orders", "order-001");
  console.log(`  ✓ Order status: ${updatedOrder?.status}`);

  const updatedItem = await tables.read("menu_items", "item-002");
  console.log(`  ✓ Salad available: ${updatedItem?.available}\n`);

  // Step 9: Display record structure
  console.log("📄 Sample Record Structure:");
  const user = await tables.read("users", "user-admin-001");
  console.log(JSON.stringify(user, null, 2));

  console.log("\n✨ Restaurant app demo completed successfully!");
  console.log("📁 All data is stored in your cloud folder as JSON files");
  console.log("🔗 Tables are organized as subfolders with individual record files");
}

runRestaurantApp().catch((error) => {
  console.error("❌ Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
