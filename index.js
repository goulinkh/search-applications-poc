import { connect } from "@canonical/jujulib/dist/api/client";

import Action from "@canonical/jujulib/dist/api/facades/action";
import Charms from "@canonical/jujulib/dist/api/facades/charms";
import Client from "@canonical/jujulib/dist/api/facades/client";
import ModelManager from "@canonical/jujulib/dist/api/facades/model-manager";

import Fuse from "fuse.js";
import inquirer from "inquirer";
import InquirerSearchList from "inquirer-search-list";
import WebSocket from "ws";
inquirer.registerPrompt("search-list", InquirerSearchList);

// import { writeFile } from "fs/promises";

const serverURL = "ws://localhost:46261";
const credentials = {
  username: "admin",
  password: "test",
};

async function getModelByName(conn, name) {
  const modelManager = conn.facades.modelManager;
  const response = await modelManager.listModels({
    tag: conn.info.user.identity,
  });
  const models = response["user-models"].map((e) => e.model);
  const model = models.find(
    (model) => model.name.toLowerCase() === name.toLowerCase()
  );
  if (!model) throw new Error("Model not found");
  return model;
}

async function getApplications(conn) {
  // Get the applications of the model
  const client = conn.facades.client;
  const modelDetails = await client.fullStatus();
  const applicationsObj = modelDetails.applications;
  const applications = [];
  Object.keys(applicationsObj).forEach((applicationName) => {
    applications.push({
      name: applicationName,
      ...applicationsObj[applicationName],
    });
  });
  return applications;
}

function searchApplications(applications, query) {
  const fuse = new Fuse(applications, {
    keys: ["name", "charm", "base.name", "base.channel"],
  });
  const applicationsResultSearch = fuse.search(query).map((e) => e.item);
  return applicationsResultSearch;
}

function getCharmDetails(conn, charm) {
  return conn.facades.charms.charmInfo({ url: charm });
}

async function getCharmsFromApplications(conn, applications) {
  const charms = new Set();
  applications.forEach((a) => charms.add(a.charm));
  return await Promise.all(
    [...charms].map(async (charm) => await getCharmDetails(conn, charm))
  );
}

function printApplicationCLI(applications) {
  console.log(
    "Applications list:",
    ["", ...applications.map((a) => a.name)].join("\n\t- ")
    // applications.map((a) => parseCharmFromString(a.charm))
  );
}

function getSelectedApplicationsByCharm(applications, charm) {
  const selectedApplications = applications.filter(
    (application) => application.charm === charm
  );
  const totalUnits = selectedApplications.reduce(
    (sum, application) => (sum += Object.keys(application.units).length),
    0
  );
  return `${selectedApplications.length} applications (${totalUnits} units) selected`;
}

async function main() {
  // Connect to the controller
  const controller = await connect(`${serverURL}/api`, {
    facades: [ModelManager],
    wsclass: WebSocket,
  });
  let conn = await controller.login(credentials);

  const testingModel = await getModelByName(conn, "tests");
  // Close the connection to the controller
  conn.transport.close();

  // Login to each model
  conn = await connect(`${serverURL}/model/${testingModel.uuid}/api`, {
    facades: [Client, Action, Charms],
    wsclass: WebSocket,
  });
  conn = await conn.login(credentials);
  const applications = await getApplications(conn);
  printApplicationCLI(applications);
  const { searchQuery } = await inquirer.prompt([
    {
      type: "input",
      message: "Search:",
      name: "searchQuery",
    },
  ]);
  // Search by user's query
  const filteredApplications = searchApplications(applications, searchQuery);
  printApplicationCLI(filteredApplications);
  // When a user clicks on "Run action"
  console.log("Running an action...");
  const charms = await getCharmsFromApplications(conn, filteredApplications);
  const { charm: selectedCharm } = await inquirer.prompt([
    {
      type: "list",
      message: "Choose applications of charm:",
      choices: charms.map((charm) => ({
        value: charm,
        name: `${charm.meta.name} (${charm.revision})`,
      })),
      name: "charm",
    },
  ]);
  if (!selectedCharm.actions?.specs) {
    console.log("There are no available actions for this charm");
    process.exit(0);
  }
  const { action: selectedAction } = await inquirer.prompt([
    {
      type: "list",
      message: getSelectedApplicationsByCharm(
        filteredApplications,
        selectedCharm.url
      ),
      choices: Object.keys(selectedCharm.actions.specs).map((actionName) => ({
        value: { name: actionName, ...selectedCharm.actions.specs[actionName] },
        name: actionName,
      })),
      name: "action",
    },
  ]);
  console.log("selectedAction", selectedAction);
  // TODO: EnqueueOperation: takes a list of Actions and queues them up to be executed as\nan operation, each action running as a task on the designated ActionReceiver.\nWe return the ID of the overall operation and each individual task

  // Close the connection to the model
  conn.transport.close();
}

main();
