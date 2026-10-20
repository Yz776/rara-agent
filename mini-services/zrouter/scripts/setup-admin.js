// Setup first admin user for KRouter
import { createUser } from "../src/services/auth-user.ts";

console.log("🔐 Setting up first admin user...\n");

try {
  const admin = createUser("admin", "password123", "admin");
  console.log("✅ Admin user created!");
  console.log(`   Username: ${admin.username}`);
  console.log(`   Password: password123`);
  console.log(`   Role: ${admin.role}`);
  console.log("\n📝 IMPORTANT: Change the default password immediately!");
  console.log("   Login at: http://localhost:3000/login.html\n");
} catch (err) {
  if (err.message.includes("already exists")) {
    console.log("⚠️  Admin user already exists!");
    console.log("   Login at: http://localhost:3000/login.html\n");
  } else {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}
