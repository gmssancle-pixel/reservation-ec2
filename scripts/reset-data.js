const { resetFileStore } = require("../lib/file-store");

async function resetData() {
  await resetFileStore();
  console.log("Data reset completed.");
}

resetData()
  .catch((error) => {
    console.error("Error while resetting data:", error);
    process.exitCode = 1;
  });
