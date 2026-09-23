const mongoose = require("mongoose");
const User = require("./models/user.model");

const URI = "mongodb+srv://ranbirseth7679554766_db_user:Eg0Pt9E1WToLyjZp@a1-fitness.j92wdbq.mongodb.net/gymza_payflow_test?retryWrites=true&w=majority";

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const u = await User.findOne({ gymId: "TEST", email: "sa@payflow.local" });
  if (!u) { console.log("USER NOT FOUND"); process.exit(1); }
  console.log("Found:", u.email, u.role, u.status);
  console.log("password[0:20]:", String(u.password).slice(0, 20));
  const ok = await u.comparePassword("Super123456");
  console.log("comparePassword('Super123456'):", ok);
  await mongoose.disconnect();
})();